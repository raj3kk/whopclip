import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { decryptSession } from "@/lib/crypto";
import { getSession } from "@/lib/store";
import { crFetch, whopCookieHeader } from "@/lib/whop";

/**
 * TEMPORARY diagnostic: GET /api/whop/session-info?device_id=...
 * Owner auth. Returns ONLY metadata about the saved Whop session:
 * cookie names, access-token expiry, updated_at. NEVER returns values.
 */
function jwtExp(v: string): { exp: string; expired: boolean; iat: string } | null {
  try {
    if (v.split(".").length !== 3) return null;
    const p = JSON.parse(Buffer.from(v.split(".")[1], "base64").toString());
    return {
      exp: new Date(p.exp * 1000).toISOString(),
      expired: p.exp * 1000 < Date.now(),
      iat: new Date(p.iat * 1000).toISOString(),
    };
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
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const q = new URL(req.url).searchParams;
  if (q.get("probe") !== "submission-scope") {
    return NextResponse.json({ error: "unknown probe" }, { status: 400 });
  }
  const device_id = q.get("device_id") ?? "";
  const cookieHeader = await whopCookieHeader(device_id);
  const out: Record<string, unknown> = {};
  for (const [name, path] of [
    ["listSubmissions", "/api/submission/submissions?limit=5"],
    ["listDrafts", "/api/submission/submission-drafts?limit=5"],
  ] as const) {
    try {
      const res = await crFetch(path, {
        cookieHeader,
        referer: "https://contentrewards.com/discover",
      });
      const text = await res.text().catch(() => "");
      let code: string | null = null;
      try {
        const j = JSON.parse(text) as { code?: string; error?: string };
        code = j.code ?? j.error ?? null;
      } catch { /* non-JSON */ }
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
      out[name] = { status: res.status, ok: res.ok, code, count };
    } catch (e) {
      out[name] = { status: -1, ok: false, code: e instanceof Error ? e.message : "net" };
    }
  }
  return NextResponse.json(out);
}
