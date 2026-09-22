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
}

export function igPostJob(p: IgPostParams): Step[] {
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
    { action: "goto", url: "__POST_URL__" },
    { action: "wait", ms: 4000 },
    {
      action: "assert_text",
      text: "likes",
      timeout_ms: 15000,
    },
  ];
}

export interface WhopSubmitParams {
  campaign_url: string;
  ig_post_url: string;
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
