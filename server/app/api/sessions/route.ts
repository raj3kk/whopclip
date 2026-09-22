import { NextRequest, NextResponse } from "next/server";
import { encryptSession, decryptSession } from "@/lib/crypto";
import { saveSession, getSession, type ServiceName } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET /api/sessions?device_id=...&service=whop|instagram
 * Owner login required. Returns the DECRYPTED cookies so the server/
 * dashboard can read and use the saved login session (automation,
 * debugging). Never expose this without owner auth.
 */
export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  const service = req.nextUrl.searchParams.get("service") ?? "";
  if (!device_id || (service !== "whop" && service !== "instagram")) {
    return NextResponse.json(
      { error: "device_id and service=whop|instagram required" },
      { status: 400 }
    );
  }
  const s = await getSession(device_id, service as ServiceName);
  if (!s) return NextResponse.json({ error: "no session saved" }, { status: 404 });
  let cookies: unknown = null;
  try {
    cookies = JSON.parse(decryptSession(s.encrypted));
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "decrypt failed" },
      { status: 500 }
    );
  }
  const names = cookies && typeof cookies === "object" ? Object.keys(cookies) : [];
  return NextResponse.json({
    device_id,
    service,
    account: s.account ?? "",
    stale: s.stale,
    updated_at: s.updated_at,
    cookie_names: names,
    cookies,
  });
}

/**
 * POST /api/sessions
 * Body: { device_id, service: "whop"|"instagram", cookies: {...}, user_agent, device_model }
 * Stores the login session AES-256-GCM encrypted.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { device_id, service, cookies, user_agent, device_model, account } = body ?? {};
    if (!device_id || (service !== "whop" && service !== "instagram") || !cookies) {
      return NextResponse.json({ error: "device_id, service, cookies required" }, { status: 400 });
    }
    const encrypted = encryptSession(JSON.stringify(cookies));
    const now = new Date().toISOString();
    await saveSession({
      device_id,
      service: service as ServiceName,
      encrypted,
      account: typeof account === "string" ? account.slice(0, 80) : "",
      user_agent: user_agent ?? "",
      device_model: device_model ?? "",
      stale: false,
      created_at: now,
      updated_at: now,
    });
    return NextResponse.json({ ok: true, service });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
