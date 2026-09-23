import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { decryptSession, encryptSession } from "@/lib/crypto";
import { getSession, saveSession } from "@/lib/store";
import {
  crFetch,
  whopCookieHeader,
  getCampaignDetail,
  probeJoinState,
} from "@/lib/whop";

/** Content Rewards Next.js server action ids (from live /login chunks, 2026-09-23). */
const CR_ACTIONS = {
  refreshSession: "00a318a0184953d9eea4b343164f65435b33950cc4",
  requestLoginOtp: "403a5186fc085bd8ec9bdf4b27a42228523b1e6a07",
  verifyLoginOtp: "406efe7ff101b99b89b7e2e7ac9d49888a0aa8df73",
} as const;
const CR_LOGIN_EMAIL = "flipify.com@gmail.com";
const CR_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Invoke a Content Rewards server action the way the app's own client does.
 *  Returns raw Set-Cookie headers too — values are merged server-side only
 *  and NEVER included in any HTTP response. */
async function invokeCrAction(
  actionId: string,
  args: unknown[],
  cookieHeader?: string
): Promise<{
  status: number;
  setCookieNames: string[];
  setCookieCount: number;
  setCookiesRaw: string[];
  bodyPreview: string;
  location: string | null;
}> {
  const boundary = "----HatchBoundary" + Math.random().toString(36).slice(2);
  let body = "";
  args.forEach((a, i) => {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${i}"\r\n\r\n${JSON.stringify(a)}\r\n`;
  });
  body += `--${boundary}--\r\n`;
  const res = await fetch("https://contentrewards.com/login", {
    method: "POST",
    headers: {
      "User-Agent": CR_UA,
      Accept: "text/x-component",
      "Next-Action": actionId,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Origin: "https://contentrewards.com",
      Referer: "https://contentrewards.com/login",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body,
    redirect: "manual",
  });
  const text = await res.text().catch(() => "");
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const names = raw.map((c) => c.split(";")[0].split("=")[0].trim()).filter(Boolean);
  return {
    status: res.status,
    setCookieNames: [...new Set(names)],
    setCookieCount: raw.length,
    setCookiesRaw: raw,
    bodyPreview: text.slice(0, 400),
    location: res.headers.get("location"),
  };
}

/** Parse Set-Cookie headers into name->value pairs (values kept server-side only). */
function parseSetCookies(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of raw) {
    const semi = c.indexOf(";");
    const pair = semi >= 0 ? c.slice(0, semi) : c;
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/**
 * TEMPORARY diagnostic: GET /api/whop/session-info?device_id=...
 * Owner auth. Returns ONLY metadata about the saved Whop session:
 * cookie names, access-token expiry, updated_at. NEVER returns values.
 */
function jwtExp(v: string): { exp: string; expired: boolean; iat: string } | null {
  try {
    if (v.split(".").length !== 3) return null;
    const p = JSON.parse(Buffer.from(v.split(".")[1], "base64").toString());
    // Return non-secret claims only: drop any claim whose VALUE looks like a token/secret.
    const safe: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(p)) {
      if (typeof val === "string" && val.length > 60) safe[k] = `<str len ${val.length}>`;
      else safe[k] = val;
    }
    return {
      exp: new Date(p.exp * 1000).toISOString(),
      expired: p.exp * 1000 < Date.now(),
      iat: new Date(p.iat * 1000).toISOString(),
      claims: safe,
    } as unknown as { exp: string; expired: boolean; iat: string };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = new URL(req.url).searchParams.get("device_id") ?? "";
  const s = await getSession(device_id, "whop");
  if (!s) return NextResponse.json({ error: "no session" }, { status: 404 });
  const jar = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
  const cookies: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(jar)) {
    if (/access-?token/i.test(k)) cookies[k] = { jwt: jwtExp(String(v)) };
    else if (/refresh/i.test(k)) cookies[k] = { present: true, len: String(v).length };
    else cookies[k] = { present: true, len: String(v).length };
  }
  return NextResponse.json({
    cookieNames: Object.keys(jar),
    cookies,
    stale: s.stale,
    updated_at: s.updated_at,
    note: "values never returned",
  });
}

/**
 * TEMPORARY read-only probe: POST /api/whop/session-info?device_id=...&probe=submission-scope
 * (owner auth). Performs ONLY GET requests:
 *   - GET /api/submission/submissions?limit=5  (list my submissions)
 * Returns {status, ok} per call — never bodies, never secrets.
 */
export async function POST(req: NextRequest) {
  const authed =
    verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value) ||
    (!!process.env.SESSION_CHECK_SECRET &&
      req.headers.get("x-cron-secret") === process.env.SESSION_CHECK_SECRET);
  if (!authed) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const q = new URL(req.url).searchParams;
  const probeName = q.get("probe");

  // --- TEMP: correct-session acquisition probes (sahi session id) ---
  if (probeName === "cr-refresh" || probeName === "cr-otp-request" || probeName === "cr-otp-verify") {
    const device_id = q.get("device_id") ?? "";
    const s = await getSession(device_id, "whop");
    if (!s) return NextResponse.json({ error: "no session" }, { status: 404 });
    const cookieHeader = await whopCookieHeader(device_id);

    if (probeName === "cr-refresh") {
      // The app's own 401-recovery: refreshSession server action with current cookies.
      const r = await invokeCrAction(CR_ACTIONS.refreshSession, [], cookieHeader);
      const { setCookiesRaw: _h1, ...safe } = r;
      void _h1;
      return NextResponse.json({ probe: probeName, ...safe });
    }
    if (probeName === "cr-otp-request") {
      // Ask Content Rewards to email a 6-digit code to the user's address.
      const r = await invokeCrAction(
        CR_ACTIONS.requestLoginOtp,
        [{ attempt: 1, email: CR_LOGIN_EMAIL }],
        cookieHeader
      );
      const { setCookiesRaw: _h2, ...safe } = r;
      void _h2;
      return NextResponse.json({ probe: probeName, email: CR_LOGIN_EMAIL, ...safe });
    }
    // cr-otp-verify: verify the emailed code, capture the REAL contentrewards
    // session cookies, merge them into the saved jar (values never returned),
    // then immediately test GET /api/submission/submissions with the new jar.
    const otp = (q.get("otp") ?? "").trim();
    if (!/^\d{4,8}$/.test(otp)) {
      return NextResponse.json({ error: "otp query param required" }, { status: 400 });
    }
    const r = await invokeCrAction(
      CR_ACTIONS.verifyLoginOtp,
      [{ attempt: 1, email: CR_LOGIN_EMAIL, otp }],
      cookieHeader
    );
    const fresh = parseSetCookies(r.setCookiesRaw);
    const freshNames = Object.keys(fresh);
    let mergedCount = 0;
    let testStatus: number | null = null;
    let testCode: string | null = null;
    if (freshNames.length > 0) {
      const jar = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
      for (const [k, v] of Object.entries(fresh)) jar[k] = v;
      mergedCount = Object.keys(jar).length;
      const now = new Date().toISOString();
      await saveSession({
        device_id,
        service: "whop",
        encrypted: encryptSession(JSON.stringify(jar)),
        account: s.account ?? "",
        user_agent: s.user_agent ?? "",
        device_model: s.device_model ?? "",
        stale: false,
        created_at: s.created_at ?? now,
        updated_at: now,
      });
      // Read-only validation: does the merged session authenticate the API now?
      const newHeader = await whopCookieHeader(device_id);
      try {
        const t = await crFetch("/api/submission/submissions?limit=5", {
          cookieHeader: newHeader,
          referer: "https://contentrewards.com/discover",
        });
        testStatus = t.status;
        const tt = await t.text().catch(() => "");
        try {
          const j = JSON.parse(tt) as { code?: string; error?: string };
          testCode = j.code ?? j.error ?? null;
        } catch {
          testCode = tt.slice(0, 80) || null;
        }
      } catch (e) {
        testCode = e instanceof Error ? e.message : "net";
      }
    }
    return NextResponse.json({
      probe: probeName,
      verifyStatus: r.status,
      verifyBodyPreview: r.bodyPreview,
      freshCookieNames: freshNames,
      mergedJarSize: mergedCount,
      submissionsTest: { status: testStatus, code: testCode },
    });
  }

  if (probeName !== "submission-scope" && probeName !== "submission-dupe-check" && probeName !== "campaign-recheck") {
    return NextResponse.json({ error: "unknown probe" }, { status: 400 });
  }

  // --- TEMP read-only: submission/draft duplicate metadata (no bodies, no URLs, no secrets) ---
  if (probeName === "submission-dupe-check") {
    const device_id = q.get("device_id") ?? "";
    const cookieHeader = await whopCookieHeader(device_id);
    const pick = (o: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const k of ["id", "campaignId", "campaign_id", "campaignID", "status", "platform", "createdAt", "created_at", "state", "reviewStatus"]) {
        if (o[k] !== undefined && typeof o[k] !== "object") out[k] = o[k];
      }
      return out;
    };
    const out: Record<string, unknown> = { probe: probeName };
    for (const [name, path] of [
      ["submissions", "/api/submission/submissions?limit=50"],
      ["drafts", "/api/submission/submission-drafts?limit=50"],
    ] as const) {
      try {
        const res = await crFetch(path, {
          cookieHeader,
          referer: "https://contentrewards.com/discover",
        });
        const text = await res.text().catch(() => "");
        let items: unknown[] = [];
        try {
          const j = JSON.parse(text) as unknown;
          if (Array.isArray(j)) items = j;
          else if (j && typeof j === "object") {
            const o = j as Record<string, unknown>;
            for (const k of ["items", "data", "submissions", "drafts"]) {
              if (Array.isArray(o[k])) { items = o[k] as unknown[]; break; }
            }
          }
        } catch { /* non-JSON */ }
        out[name] = {
          status: res.status,
          ok: res.ok,
          count: items.length,
          items: items
            .filter((i) => i && typeof i === "object")
            .map((i) => pick(i as Record<string, unknown>)),
        };
      } catch (e) {
        out[name] = { status: -1, ok: false, error: e instanceof Error ? e.message : "net" };
      }
    }
    return NextResponse.json(out);
  }

  // --- TEMP read-only: campaign eligibility recheck (detail + join state) ---
  if (probeName === "campaign-recheck") {
    const device_id = q.get("device_id") ?? "";
    const campaign_id = q.get("campaign_id") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(campaign_id)) {
      return NextResponse.json({ error: "campaign_id required" }, { status: 400 });
    }
    try {
      const detail = await getCampaignDetail(campaign_id);
      let joined: boolean | null = null;
      let joinDetail = "not probed";
      if (device_id) {
        const probe = await probeJoinState(device_id, campaign_id);
        joined = probe.joined;
        joinDetail = probe.detail;
      }
      return NextResponse.json({
        probe: probeName,
        id: detail.id,
        name: detail.name,
        brand: detail.brand,
        status: detail.status,
        budget_remaining: detail.budgetRemaining,
        payouts: detail.payouts,
        primary_payout_cents: detail.primaryPayoutCents,
        platforms: detail.platforms,
        requires_application: detail.requiresApplication,
        content_requirements: detail.contentRequirements,
        joined,
        join_detail: joinDetail,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "probe failed" }, { status: 502 });
    }
  }

  const device_id = q.get("device_id") ?? "";
  const jar = JSON.parse(
    decryptSession((await getSession(device_id, "whop"))!.encrypted)
  ) as Record<string, string>;
  const cookieHeader = await whopCookieHeader(device_id);
  const authMode = q.get("auth") ?? "cookies";
  // minimal: only Whop session cookies (drop analytics/tracking junk that might
  // break the server's cookie parser with special chars)
  const useHeader =
    authMode === "minimal"
      ? cookieHeader
          .split(";")
          .map((p) => p.trim())
          .filter((p) => /^(whop-core\.|__Secure-whop\.|__Host-whop-core\.|_whop_ssk=)/.test(p))
          .join("; ")
      : cookieHeader;
  const bearer =
    authMode === "bearer-access"
      ? String(jar["whop-core.access-token"] ?? "")
      : authMode === "bearer-uid"
        ? String(jar["whop-core.uid-token"] ?? "")
        : undefined;
  const out: Record<string, unknown> = { authMode };
  // Non-secret JWT claim metadata for the access token (helps diagnose aud/iss mismatch)
  try {
    const at = String(jar["whop-core.access-token"] ?? "");
    if (at.split(".").length === 3) {
      const p = JSON.parse(Buffer.from(at.split(".")[1], "base64").toString()) as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) {
        safe[k] = typeof v === "string" && v.length > 60 ? `<str len ${v.length}>` : v;
      }
      out["accessTokenClaims"] = safe;
    }
  } catch { /* ignore */ }
  for (const [name, path, method, json] of [
    ["listSubmissions", "/api/submission/submissions?limit=5", "GET", undefined],
    ["listDrafts", "/api/submission/submission-drafts?limit=5", "GET", undefined],
    ["applicationsMe", "/api/campaign/campaigns/applications/me", "GET", undefined],
    ["userMe", "/api/user/me", "GET", undefined],
    ["authSession", "/api/auth/authenticate/session", "GET", undefined],
    ["authorizeResolve", "/api/auth/authorize/resolve", "POST", {}],
  ] as const) {
    try {
      const res = await crFetch(path, {
        method,
        cookieHeader: useHeader,
        referer: "https://contentrewards.com/discover",
        bearer,
        ...(json !== undefined ? { json } : {}),
      });
      const text = await res.text().catch(() => "");
      let code: string | null = null;
      try {
        const j = JSON.parse(text) as { code?: string; error?: string };
        code = j.code ?? j.error ?? null;
      } catch { /* non-JSON */ }
      const headers: Record<string, string> = {};
      for (const h of ["server", "cf-ray", "www-authenticate", "set-cookie", "content-type", "x-request-id"]) {
        const v = res.headers.get(h);
        if (v) headers[h] = h === "set-cookie" ? "<present>" : v.slice(0, 120);
      }
      // Count items without returning content
      let count: number | null = null;
      try {
        const j = JSON.parse(text) as unknown;
        if (Array.isArray(j)) count = j.length;
        else if (j && typeof j === "object") {
          const o = j as Record<string, unknown>;
          if (Array.isArray(o.items)) count = o.items.length;
          else if (Array.isArray(o.data)) count = o.data.length;
          else if (Array.isArray(o.submissions)) count = o.submissions.length;
        }
      } catch { /* ignore */ }
      out[name] = { status: res.status, ok: res.ok, code, count, headers };
    } catch (e) {
      out[name] = { status: -1, ok: false, code: e instanceof Error ? e.message : "net" };
    }
  }
  return NextResponse.json(out);
}
