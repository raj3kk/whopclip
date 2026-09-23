import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { decryptSession } from "@/lib/crypto";
import { getSession } from "@/lib/store";

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
