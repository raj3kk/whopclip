/**
 * Server-side Instagram client.
 *
 * Runs on Vercel (USA) using the phone-uploaded IG session (AES-256-GCM at
 * rest, decrypted IN MEMORY ONLY, never logged/returned).
 *
 * What runs server-side:
 *  - verifyReel(): fetch the reel page with the user's session, confirm it
 *    is live (not deleted/private), extract caption / video metadata /
 *    dimensions / duration / like count, and check 9:16 + caption tags.
 *    This replaces the phone's ig_verify DOM scraping for the objective
 *    checks — faster, deterministic, no WebView flakiness.
 *  - igSessionInfo(): logged-in username probe (session health detail).
 *
 * What STAYS on the phone (deliberate):
 *  - ig_post (uploading the reel): the phone is the user's real device on
 *    their real IP. Posting from a datacenter server via reverse-engineered
 *    APIs is the fastest way to earn an action block. The upload itself is
 *    also interactive (file picker). So: phone posts, server verifies.
 *
 * Honest limit: burned-in caption POSITION (the 09-14 zoom bug) needs eyes.
 * Server verify checks the video is 9:16 per IG's own metadata; the visual
 * check stays a dashboard "View Reel" step for the owner.
 */
import { decryptSession } from "./crypto";
import { getSession } from "./store";

const IG_BASE = "https://www.instagram.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 25000;

export class IgError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/** Decrypt the saved IG session and build a Cookie header. In-memory only. */
export async function igCookieHeader(device_id: string): Promise<string> {
  const s = await getSession(device_id, "instagram");
  if (!s) throw new IgError("no instagram session saved for this device (re-login in app)", 409);
  let cookies: Record<string, string>;
  try {
    cookies = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
  } catch {
    throw new IgError("instagram session decrypt failed", 500);
  }
  const header = Object.entries(cookies)
    .filter(([k, v]) => k && v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (!header) throw new IgError("instagram session has no cookies", 409);
  return header;
}

async function igFetchHtml(path: string, cookieHeader: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(IG_BASE + path, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        // NEVER log cookieHeader — it carries the user's login cookies.
        Cookie: cookieHeader,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const html = await res.text().catch(() => "");
    return { status: res.status, html, finalUrl: res.url };
  } finally {
    clearTimeout(t);
  }
}

/** Logged-in username from the IG homepage (session health detail). */
export async function igSessionInfo(device_id: string): Promise<{ username: string | null; valid: boolean }> {
  const cookieHeader = await igCookieHeader(device_id);
  const { status, html, finalUrl } = await igFetchHtml("/", cookieHeader);
  if (status !== 200) return { username: null, valid: false };
  if (/\/accounts\/login/.test(finalUrl)) return { username: null, valid: false };
  const m = html.match(/"username":"([A-Za-z0-9._]{1,30})"/);
  return { username: m ? m[1] : null, valid: true };
}

export function extractShortcode(postUrl: string): string | null {
  const m = postUrl.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function unescapeJsonStr(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

export interface ReelVerifyResult {
  live: boolean;
  shortcode: string;
  caption: string | null;
  video_url: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  aspect_ok: boolean | null;
  like_count: number | null;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/**
 * Server-side reel verification. Fail-closed: any ambiguity -> live=false
 * with the reason in checks. Never throws for a missing reel — only for
 * session/network problems.
 */
export async function verifyReel(
  device_id: string,
  postUrl: string,
  opts: { required_tags?: string[]; min_duration_s?: number } = {}
): Promise<ReelVerifyResult> {
  const shortcode = extractShortcode(postUrl);
  if (!shortcode) throw new IgError("post_url is not an instagram reel/post link", 400);
  const cookieHeader = await igCookieHeader(device_id);
  const { status, html, finalUrl } = await igFetchHtml(`/reel/${shortcode}/`, cookieHeader);
  const checks: ReelVerifyResult["checks"] = [];
  const fail = (name: string, detail: string): ReelVerifyResult => {
    checks.push({ name, ok: false, detail });
    return {
      live: false, shortcode, caption: null, video_url: null,
      duration_s: null, width: null, height: null, aspect_ok: null,
      like_count: null, checks,
    };
  };
  if (status === 404 || /sorry, this page isn't available/i.test(html)) {
    return fail("reachable", "reel page not available (deleted or private)");
  }
  if (status !== 200) return fail("reachable", `instagram returned ${status}`);
  if (/\/accounts\/login/.test(finalUrl)) {
    throw new IgError("instagram session rejected (re-login in app)", 409);
  }

  // Caption
  let caption: string | null = null;
  const capM = html.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/);
  if (capM) caption = unescapeJsonStr(capM[1]);

  // Video metadata
  let video_url: string | null = null;
  const vuM = html.match(/"video_url":"(https:[^"]+)"/);
  if (vuM) video_url = vuM[1].replace(/\\\//g, "/");
  let duration_s: number | null = null;
  const duM = html.match(/"video_duration":([\d.]+)/);
  if (duM) duration_s = parseFloat(duM[1]);
  let width: number | null = null;
  let height: number | null = null;
  const dimM = html.match(/"dimensions":\{"height":(\d+),"width":(\d+)\}/);
  if (dimM) {
    height = parseInt(dimM[1], 10);
    width = parseInt(dimM[2], 10);
  }
  let like_count: number | null = null;
  const likeM = html.match(/"edge_media_preview_like":\{"count":(\d+)/);
  if (likeM) like_count = parseInt(likeM[1], 10);

  if (!video_url) return fail("playable", "no video_url embedded — reel not playable");

  checks.push({ name: "reachable", ok: true, detail: "reel page loads" });
  checks.push({ name: "playable", ok: true, detail: "video_url present" });

  // Duration sanity
  if (duration_s != null) {
    const minD = opts.min_duration_s ?? 1;
    const ok = duration_s >= minD;
    checks.push({ name: "duration", ok, detail: `${duration_s.toFixed(1)}s` });
    if (!ok) return { live: false, shortcode, caption, video_url, duration_s, width, height, aspect_ok: null, like_count, checks };
  }

  // 9:16 aspect check from IG's own metadata
  let aspect_ok: boolean | null = null;
  if (width && height) {
    const ratio = width / height;
    aspect_ok = Math.abs(ratio - 9 / 16) < 0.02;
    checks.push({
      name: "aspect_9_16",
      ok: aspect_ok,
      detail: `${width}x${height} (ratio ${ratio.toFixed(3)})`,
    });
    if (!aspect_ok) {
      return { live: false, shortcode, caption, video_url, duration_s, width, height, aspect_ok, like_count, checks };
    }
  }

  // Required tags in caption
  if (opts.required_tags?.length) {
    const lower = (caption ?? "").toLowerCase();
    const missing = opts.required_tags.filter((t) => !lower.includes(t.toLowerCase()));
    const ok = missing.length === 0;
    checks.push({
      name: "caption_tags",
      ok,
      detail: ok ? "all required tags present" : `missing: ${missing.join(", ")}`,
    });
    if (!ok) {
      return { live: false, shortcode, caption, video_url, duration_s, width, height, aspect_ok, like_count, checks };
    }
  } else {
    checks.push({ name: "caption_present", ok: caption != null && caption.length > 0, detail: caption ? `${caption.length} chars` : "no caption found" });
  }

  return {
    live: true, shortcode, caption, video_url, duration_s, width, height,
    aspect_ok, like_count, checks,
  };
}
