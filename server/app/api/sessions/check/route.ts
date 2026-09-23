import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { checkAllSessions } from "@/lib/sessionCheck";

/**
 * POST /api/sessions/check
 * Body: { device_id }
 *
 * Server-side session health check: decrypts the saved Whop/Instagram
 * cookies and verifies each login is still valid with a lightweight
 * authenticated HTTP probe. Definitively-dead sessions are marked stale
 * (so the app prompts re-login BEFORE a job fails); inconclusive probes
 * (rate limits, network errors) never touch the stale flag.
 *
 * Auth: owner login cookie, or x-cron-secret matching SESSION_CHECK_SECRET
 * (for the automated 6-hour cron).
 */
function authorized(req: NextRequest): boolean {
  if (verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) return true;
  const secret = process.env.SESSION_CHECK_SECRET || "";
  const header = req.headers.get("x-cron-secret") || "";
  return !!secret && header === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    if (!device_id) {
      return NextResponse.json({ error: "device_id required" }, { status: 400 });
    }
    const results = await checkAllSessions(device_id);
    return NextResponse.json({ device_id, results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
