import { NextRequest, NextResponse } from "next/server";
import { encryptSession } from "@/lib/crypto";
import { saveSession, type ServiceName } from "@/lib/store";

/**
 * POST /api/sessions
 * Body: { device_id, service: "whop"|"instagram", cookies: {...}, user_agent, device_model }
 * Stores the login session AES-256-GCM encrypted.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { device_id, service, cookies, user_agent, device_model } = body ?? {};
    if (!device_id || (service !== "whop" && service !== "instagram") || !cookies) {
      return NextResponse.json({ error: "device_id, service, cookies required" }, { status: 400 });
    }
    const encrypted = encryptSession(JSON.stringify(cookies));
    const now = new Date().toISOString();
    await saveSession({
      device_id,
      service: service as ServiceName,
      encrypted,
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
