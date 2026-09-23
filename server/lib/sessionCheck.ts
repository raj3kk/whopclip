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
 * Whop probe: GET https://whop.com/dashboard/ with the saved cookies.
 * Logged-out users are bounced to a login page; logged-in users get 200
 * with dashboard content. redirect:"manual" lets us see the bounce.
 */
async function probeWhop(
  cookieHeader: string,
  userAgent: string
): Promise<ProbeOutcome> {
  let res: Response;
  try {
    res = await fetchWithTimeout("https://whop.com/dashboard/", {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: cookieHeader,
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    return {
      valid: null,
      detail: `network error: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
  // Bounced to login?
  if (res.status >= 300 && res.status < 400) {
    const loc = (res.headers.get("location") || "").toLowerCase();
    if (loc.includes("login") || loc.includes("signin") || loc.includes("auth")) {
      return { valid: false, detail: `redirected to login (${res.status} -> ${loc.slice(0, 80)})` };
    }
    return { valid: null, detail: `unexpected redirect (${res.status} -> ${loc.slice(0, 80)})` };
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
  // Definitive logged-out markers on the returned page.
  if (
    low.includes('href="/login"') ||
    low.includes("'/login'") ||
    /log in to whop/i.test(html)
  ) {
    // Make sure it's really a login page, not just a login link in a footer.
    if (low.includes("password") && (low.includes("log in") || low.includes("sign in")) && low.length < 200000) {
      return { valid: false, detail: "login page content returned" };
    }
  }
  if (res.status === 200 && low.length > 5000) {
    return { valid: true, detail: `dashboard reachable (${res.status}, ${(low.length / 1024).toFixed(0)}kb)` };
  }
  return { valid: null, detail: `unexpected status ${res.status}` };
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
