import { decryptSession } from "./crypto";
import {
  getSession,
  markSessionStale,
  clearSessionStale,
  type ServiceName,
} from "./store";

/**
 * Server-side session health checker.
 *
 * The phone uploads encrypted Whop/Instagram login cookies
 * (POST /api/sessions). This module DECRYPTS them server-side and verifies
 * the login is still valid with a lightweight authenticated HTTP request —
 * so stale sessions are detected proactively instead of waiting for a
 * phone job to fail mid-run.
 *
 * Conservative by design: only a DEFINITIVE logged-out signal marks a
 * session stale. Network errors, rate limits (429), challenge pages and
 * timeouts are reported as `inconclusive` and never touch the stale flag.
 */

export interface SessionCheckResult {
  service: ServiceName;
  checked: boolean;
  /** true = login still valid, false = definitively logged out */
  valid: boolean | null;
  inconclusive: boolean;
  detail: string;
  markedStale: boolean;
  clearedStale: boolean;
}

function cookiesToHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([k, v]) => k && v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

const FETCH_TIMEOUT_MS = 20000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

interface ProbeOutcome {
  valid: boolean | null; // null = inconclusive
  detail: string;
}

/**
 * Whop probe: GET https://whop.com/dashboard/ with the saved cookies,
 * following redirects manually (up to 3 hops). Logged-out users are bounced
 * to a login page; logged-in users land on their dashboard/townhall.
 */
async function probeWhop(
  cookieHeader: string,
  userAgent: string
): Promise<ProbeOutcome> {
  const headers = {
    Cookie: cookieHeader,
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  let url = "https://whop.com/dashboard/";
  let hops = 0;
  try {
    while (hops < 3) {
      const res = await fetchWithTimeout(url, {
        method: "GET",
        redirect: "manual",
        headers,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") || "";
        const lowLoc = loc.toLowerCase();
        // Definitive logged-out bounce.
        if (
          lowLoc.includes("login") ||
          lowLoc.includes("signin") ||
          lowLoc.includes("/auth")
        ) {
          return { valid: false, detail: `bounced to login (${res.status} -> ${loc.slice(0, 80)})` };
        }
        // Follow internal redirects (e.g. /dashboard/ -> /townhall/).
        url = new URL(loc, url).toString();
        hops++;
        continue;
      }
      if (res.status === 429) return { valid: null, detail: "rate limited (429)" };
      if (res.status >= 500) return { valid: null, detail: `server error (${res.status})` };
      if (res.status !== 200) {
        return { valid: null, detail: `unexpected status ${res.status} at ${url.slice(0, 60)}` };
      }
      let html = "";
      try {
        html = await res.text();
      } catch {
        return { valid: null, detail: "could not read response body" };
      }
      const low = html.toLowerCase();
      // Login-page content = definitively logged out.
      if (
        low.includes("password") &&
        (low.includes("log in to") || low.includes("sign in to")) &&
        low.length < 300000
      ) {
        return { valid: false, detail: "login page content returned" };
      }
      // Landed on an authenticated area (dashboard/townhall/discover) with
      // real content and no login markers = session alive.
      const host = new URL(url).pathname.toLowerCase();
      const authedArea =
        host.includes("dashboard") ||
        host.includes("townhall") ||
        host.includes("discover") ||
        host.includes("hub");
      if (low.length > 5000 && authedArea) {
        return {
          valid: true,
          detail: `landed on ${host.slice(0, 40)} (${(low.length / 1024).toFixed(0)}kb, ${hops} redirect${hops === 1 ? "" : "s"})`,
        };
      }
      // Bounced from an authenticated URL all the way to the marketing
      // homepage ("/") = cookies not authenticating. Whop never bounces a
      // logged-in user from /dashboard/ to the public homepage.
      const atRoot = host === "/" || host === "";
      const hasLoginCta =
        low.includes("log in") || low.includes("sign up") || low.includes("get started");
      if (atRoot && hasLoginCta && hops > 0) {
        return {
          valid: false,
          detail: `bounced to public homepage after ${hops} redirect${hops === 1 ? "" : "s"} — not authenticated`,
        };
      }
      return {
        valid: null,
        detail: `landed on ${host.slice(0, 60)} — ambiguous content`,
      };
    }
    return { valid: null, detail: "too many redirects" };
  } catch (e) {
    return {
      valid: null,
      detail: `network error: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}

/**
 * Instagram probe: GET https://www.instagram.com/ with the saved cookies.
 * Logged-out -> 302 to /accounts/login/. Logged-in -> 200.
 * Instagram rate-limits datacenter IPs aggressively; 429/challenge pages
 * are inconclusive, never stale.
 */
async function probeInstagram(
  cookieHeader: string,
  userAgent: string
): Promise<ProbeOutcome> {
  let res: Response;
  try {
    res = await fetchWithTimeout("https://www.instagram.com/", {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: cookieHeader,
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Mode": "navigate",
      },
    });
  } catch (e) {
    return {
      valid: null,
      detail: `network error: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = (res.headers.get("location") || "").toLowerCase();
    if (loc.includes("/accounts/login")) {
      return { valid: false, detail: "redirected to /accounts/login/" };
    }
    return { valid: null, detail: `unexpected redirect (${res.status})` };
  }
  if (res.status === 429) return { valid: null, detail: "rate limited (429)" };
  if (res.status >= 500) return { valid: null, detail: `server error (${res.status})` };
  let html = "";
  try {
    html = await res.text();
  } catch {
    return { valid: null, detail: "could not read response body" };
  }
  const low = html.toLowerCase();
  if (low.includes("/accounts/login/") && low.includes("password")) {
    return { valid: false, detail: "login page content returned" };
  }
  // Logged-in homepage embeds viewer data; a bare 200 with real content
  // and no login redirect is a good validity signal.
  if (res.status === 200 && low.length > 20000 && !low.includes("login_and_signup_page")) {
    return { valid: true, detail: `homepage reachable (${(low.length / 1024).toFixed(0)}kb)` };
  }
  return { valid: null, detail: `unexpected status ${res.status}` };
}

/** Check one saved session. Never throws — failures become inconclusive. */
export async function checkSession(
  device_id: string,
  service: ServiceName
): Promise<SessionCheckResult> {
  const fail = (detail: string): SessionCheckResult => ({
    service,
    checked: false,
    valid: null,
    inconclusive: true,
    detail,
    markedStale: false,
    clearedStale: false,
  });
  try {
    const s = await getSession(device_id, service);
    if (!s) return fail("no session saved");
    let cookies: Record<string, string>;
    try {
      cookies = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
    } catch (e) {
      return fail(`decrypt failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
    const names = Object.keys(cookies);
    if (names.length === 0) return fail("session has no cookies");
    const header = cookiesToHeader(cookies);
    const ua =
      s.user_agent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

    const probe: ProbeOutcome =
      service === "whop"
        ? await probeWhop(header, ua)
        : await probeInstagram(header, ua);

    const result: SessionCheckResult = {
      service,
      checked: true,
      valid: probe.valid,
      inconclusive: probe.valid === null,
      detail: `${names.length} cookies — ${probe.detail}`,
      markedStale: false,
      clearedStale: false,
    };

    // Apply the verdict to the stored session.
    if (probe.valid === false && !s.stale) {
      await markSessionStale(device_id, service);
      result.markedStale = true;
    } else if (probe.valid === true && s.stale) {
      // Session recovered (user re-logged in on the web, cookies refreshed
      // by a newer upload, etc.) — clear the stale flag.
      await clearSessionStale(device_id, service);
      result.clearedStale = true;
    }
    return result;
  } catch (e) {
    return fail(`checker error: ${e instanceof Error ? e.message : "unknown"}`);
  }
}

/** Check both services for a device. */
export async function checkAllSessions(
  device_id: string
): Promise<SessionCheckResult[]> {
  return [await checkSession(device_id, "whop"), await checkSession(device_id, "instagram")];
}
