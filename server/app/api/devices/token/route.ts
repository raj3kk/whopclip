import { NextResponse } from "next/server";
import {
  saveDeviceFcmToken,
  getDeviceFcmToken,
  clearDeviceFcmToken,
} from "@/lib/store";

/**
 * /api/devices/token — phone's FCM registration token registry.
 * The phone calls this directly (same as /api/devices/presence — no owner
 * login). Token changes (reinstall, refresh) are upserts.
 *
 * POST   { device_id, fcm_token } -> register/upsert   (200 { ok:true })
 * GET    ?device_id=...            -> self-check       (200 { ok:true, registered, fcm_token } / 404)
 * DELETE ?device_id=...            -> unregister       (200 { ok:true, removed })
 *
 * NOTE: server-side only half of FCM — the Android app does not have the
 * FCM client SDK yet, so pushes have no receiver until the app adds it.
 * The send path (lib/fcm.ts) and this registry are the server half.
 */
export const dynamic = "force-dynamic";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: Request) {
  let body: { device_id?: unknown; fcm_token?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("bad request");
  }
  const device_id = String(body.device_id || "");
  const fcm_token = String(body.fcm_token || "");
  if (!device_id) return bad("device_id required");
  if (!fcm_token || fcm_token.length < 20) return bad("fcm_token required");
  await saveDeviceFcmToken(device_id, fcm_token);
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const device_id = new URL(req.url).searchParams.get("device_id") || "";
  if (!device_id) return bad("device_id required");
  const fcm_token = await getDeviceFcmToken(device_id);
  if (!fcm_token) {
    return NextResponse.json(
      { ok: false, registered: false, device_id },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, registered: true, device_id, fcm_token });
}

export async function DELETE(req: Request) {
  const device_id = new URL(req.url).searchParams.get("device_id") || "";
  if (!device_id) return bad("device_id required");
  await clearDeviceFcmToken(device_id);
  return NextResponse.json({ ok: true, removed: true, device_id });
}
