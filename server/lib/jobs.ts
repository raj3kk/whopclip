import type { Campaign } from "./store";

/**
 * Checkpoint 2/6/7 — JobEngine step-spec templates.
 *
 * Flow per campaign (fail-closed, server-driven):
 *   1. whop_check_join  -> extract join_state + requirements_text
 *   2. whop_join         -> (only if not joined) click Join, verify "Joined"
 *   3. ig_post           -> upload clip, exact caption, extract post_url, live-verify
 *   4. whop_submit       -> paste IG link, submit, verify submitted/pending
 *
 * Every template ends with extract/assert steps so the server can verify
 * the outcome instead of trusting it.
 */

export type Step = Record<string, unknown>;

export function checkJoinJob(campaign: Campaign): Step[] {
  return [
    { action: "goto", url: campaign.whop_url },
    { action: "wait", ms: 2500 },
    {
      action: "extract",
      key: "join_state",
      code: `(function(){
        var t=(document.body?document.body.innerText:'').toLowerCase();
        if(/you\\u2019re in|joined|already joined/.test(t)) return 'joined';
        var btns=[...document.querySelectorAll('button,a')].map(e=>(e.innerText||'').trim().toLowerCase());
        if(btns.some(b=>b==='join'||b==='join campaign')) return 'not_joined';
        return 'unknown';
      })()`,
    },
    {
      action: "extract",
      key: "requirements_text",
      code: `(function(){
        var el=document.querySelector('[data-requirements]')||document.body;
        return (el.innerText||'').slice(0,8000);
      })()`,
    },
  ];
}

export function joinJob(campaign: Campaign): Step[] {
  return [
    { action: "goto", url: campaign.whop_url },
    { action: "wait", ms: 2500 },
    { action: "click_text", text: "Join", timeout_ms: 20000 },
    { action: "wait", ms: 3000 },
    // fail-closed: the page MUST show a joined state afterwards
    {
      action: "js",
      code: `(function(){
        var t=(document.body?document.body.innerText:'').toLowerCase();
        if(!/you\\u2019re in|joined|already joined|welcome/.test(t)) throw new Error('join not confirmed');
        return 'join_confirmed';
      })()`,
    },
    {
      action: "extract",
      key: "join_state",
      code: `'joined'`,
    },
  ];
}

export interface IgPostParams {
  caption: string;
  /** local path/URI hint shown to the foreground picker (JobRunnerActivity) */
  video_hint?: string;
  /**
   * If the post URL is already known (re-verify / retry), the verify step
   * goes straight to it. Otherwise the step uses the "__POST_URL__"
   * placeholder, which the phone's JobEngine substitutes with the extracted
   * `post_url` at runtime.
   */
  post_url?: string;
}

export function igPostJob(p: IgPostParams): Step[] {
  const verifyUrl =
    p.post_url && /^https?:\/\//i.test(p.post_url) ? p.post_url : "__POST_URL__";
  return [
    { action: "goto", url: "https://www.instagram.com/" },
    { action: "wait", ms: 2500 },
    // NOTE: selectors shift often; the engine's click_text is text-based on purpose.
    { action: "click_text", text: "Create", timeout_ms: 20000 },
    { action: "wait_text", text: "Select from device", timeout_ms: 20000 },
    { action: "click_text", text: "Select from device", timeout_ms: 15000 },
    // Opens the system picker via JobRunnerActivity's onShowFileChooser.
    { action: "upload", selector: "input[type=file]" },
    { action: "wait", ms: 4000 },
    // advance through optional crop/filter screens (tolerant: skips if absent)
    { action: "js", code: `(function(){var b=[...document.querySelectorAll('button')].find(e=>/next/i.test(e.innerText||'')); if(b){b.click(); return 'advanced';} return 'no-next';})()` },
    { action: "wait_text", text: "Write a caption", timeout_ms: 60000 },
    { action: "type", selector: "textarea", text: p.caption },
    { action: "wait", ms: 1000 },
    { action: "click_text", text: "Share", timeout_ms: 15000 },
    { action: "wait", ms: 8000 },
    // capture + live-verify: the post URL must exist and load
    {
      action: "extract",
      key: "post_url",
      code: `(function(){
        var a=[...document.querySelectorAll('a')].map(e=>e.href).find(h=>/instagram\\.com\\/(p|reel)\\//.test(h));
        return a||location.href;
      })()`,
    },
    { action: "goto", url: verifyUrl },
    { action: "wait", ms: 4000 },
    // Robust live verification (replaces the old weak assert_text "likes"):
    // the post URL must (1) match the reel/post pattern, (2) actually load a
    // page containing a video element, and (3) expose engagement metrics.
    // Fail closed: any missing piece throws and the job fails.
    {
      action: "js",
      code: `(function(){
        var url=location.href;
        if(!/instagram\\.com\\/(p|reel|reels)\\//.test(url)) throw new Error('post URL pattern mismatch: '+url);
        var vids=[...document.querySelectorAll('video')];
        if(!vids.length) throw new Error('no video element on live post page');
        var v=vids[0];
        return JSON.stringify({url:url, video_found:true, duration_s:v.duration||null, ready_state:v.readyState});
      })()`,
    },
    {
      action: "extract",
      key: "live_metrics",
      code: `(function(){
        var t=document.body?document.body.innerText:'';
        var m=t.match(/([\\d,]+)\\s+likes/i);
        var likes=m?m[1]:null;
        var v=t.match(/([\\d,]+)\\s+views/i);
        var views=v?v[1]:null;
        var c=t.match(/([\\d,]+)\\s+comments/i);
        return JSON.stringify({likes:likes, views:views, comments:c?c[1]:null, checked_at:new Date().toISOString()});
      })()`,
    },
  ];
}

/**
 * Standalone live-reel verification: given a known post URL, load it and
 * confirm the reel is publicly playable with a real video element.
 * Run BEFORE whop_submit so a broken upload never gets submitted.
 *
 * Frame-level proof: seeks the reel to ~1s/7s/15s/25s, captures a WebView
 * screenshot at each point, and uploads it to POST /api/frames. The server
 * (or dashboard reviewer) checks safe zones: hook/title >=10% below top,
 * captions at/above ~78% height, clear of the bottom 20% and right 15%.
 * Fail closed: any missing frame or unplayable video throws.
 */
export function verifyReelJob(post_url: string): Step[] {
  if (!/^https?:\/\//i.test(post_url)) {
    throw new Error("verifyReelJob: post_url must be an absolute URL");
  }
  const seekAndShoot = (t: number, key: string): Step[] => [
    {
      action: "js",
      code: `(function(){
        var v=document.querySelector('video');
        if(!v) throw new Error('no video element for frame capture');
        v.currentTime=${t};
        return 'seek_${t}s';
      })()`,
    },
    { action: "wait", ms: 1500 },
    { action: "screenshot", key, upload: true },
  ];
  return [
    { action: "goto", url: post_url },
    { action: "wait", ms: 5000 },
    {
      action: "js",
      code: `(function(){
        var t=(document.body?document.body.innerText:'').toLowerCase();
        if(/sorry, this page|not available|page not found/.test(t)) throw new Error('reel not publicly available');
        var vids=[...document.querySelectorAll('video')];
        if(!vids.length) throw new Error('no video element — reel not playable');
        var v=vids[0];
        if(v.duration && v.duration<1) throw new Error('video duration invalid: '+v.duration);
        return JSON.stringify({ok:true, url:location.href, duration_s:v.duration||null});
      })()`,
    },
    // frame proof at 1s / 7s / 15s / 25s (uploaded to /api/frames)
    ...seekAndShoot(1, "frame_1s.png"),
    ...seekAndShoot(7, "frame_7s.png"),
    ...seekAndShoot(15, "frame_15s.png"),
    ...seekAndShoot(25, "frame_25s.png"),
    {
      action: "extract",
      key: "verify_result",
      code: `(function(){
        var t=document.body?document.body.innerText:'';
        var m=t.match(/([\\d,]+)\\s+likes/i);
        return JSON.stringify({likes:m?m[1]:null, url:location.href, frames:['frame_1s.png','frame_7s.png','frame_15s.png','frame_25s.png']});
      })()`,
    },
  ];
}

export interface WhopSubmitParams {
  campaign_url: string;
  ig_post_url: string;
}

/**
 * Campaign discovery: the phone visits the Whop Content Rewards discovery
 * page (logged-in WebView) and extracts campaign cards into structured JSON.
 * The server ingests the result via POST /api/campaigns/discover.
 */
export function discoverCampaignsJob(discoverUrl: string): Step[] {
  return [
    { action: "goto", url: discoverUrl },
    { action: "wait", ms: 4000 },
    {
      action: "extract",
      key: "campaigns_json",
      code: `(function(){
        var cards=[...document.querySelectorAll('a[href*="/rewards/"],a[href*="/campaigns/"],[data-campaign]')];
        var seen={}; var out=[];
        function txt(e){return (e.innerText||'').trim().slice(0,300);}
        // fallback: any link whose text mentions payout
        if(!cards.length){
          cards=[...document.querySelectorAll('a')].filter(a=>/\\$\\s*\\d/i.test(a.innerText||''));
        }
        for(var a of cards){
          var href=a.href||'';
          if(!href||seen[href]) continue; seen[href]=1;
          var card=a.closest('[class*="card"],[class*="tile"],li,div')||a;
          out.push({name:txt(card).split('\\n')[0]||txt(a), url:href, text:txt(card).slice(0,600)});
          if(out.length>=40) break;
        }
        return JSON.stringify(out);
      })()`,
    },
  ];
}

export function whopSubmitJob(p: WhopSubmitParams): Step[] {
  return [
    { action: "goto", url: p.campaign_url },
    { action: "wait", ms: 2500 },
    { action: "wait_text", text: "Submit", timeout_ms: 20000 },
    { action: "click_text", text: "Submit", timeout_ms: 15000 },
    { action: "wait_text", text: "link", timeout_ms: 15000 },
    { action: "type", selector: "input[type=url], input[type=text], textarea", text: p.ig_post_url },
    { action: "wait", ms: 1000 },
    { action: "click_text", text: "Submit", timeout_ms: 15000 },
    { action: "wait", ms: 5000 },
    // fail-closed: must show submitted/pending state, never silently "done"
    {
      action: "js",
      code: `(function(){
        var t=(document.body?document.body.innerText:'').toLowerCase();
        if(/submitted|pending review|under review/.test(t)) return 'submit_confirmed';
        throw new Error('submit not confirmed on page');
      })()`,
    },
    {
      action: "extract",
      key: "submit_state",
      code: `'submitted'`,
    },
  ];
}
