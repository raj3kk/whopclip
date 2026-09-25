import { NextResponse } from "next/server";
import { getDeviceFcmToken, listDevices } from "@/lib/store";
import { sendPush, fcmConfigured } from "@/lib/fcm";

/**
 * POST /api/agent/ping — cron/worker nudge hook: one wake push to a phone.
 *
 * Auth: x-cron-secret header (CRON_SECRET) — same as /api/internal/* and
 * the schedule/render routes. If CRON_SECRET is not configured the
 * endpoint is unavailable (503).
 *
 * Body: { device_id?, title?, body?, data? }
 *   device_id omitted -> the most recently active registered device.
 * Always HTTP 200 with a structured result — a push failure is reported,
 * never a 500 (fail-soft: phone polling is the real fallback).
 *
 * Example: the Hogan recovery cron calls this when a chain is parked and
 * the phone has been offline, to nudge the phone to poll.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, reason: "cron_secret_not_configured" },
      { status: 503 }
    );
  }
  const given =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (given !== secret) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let body: {
    device_id?: unknown;
    title?: unknown;
    body?: unknown;
    data?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Resolve the target device.
  let device_id = String(body.device_id || "");
  if (!device_id) {
    const devices = await listDevices().catch(() => []);
    device_id = devices[0]?.device_id ?? "";
  }
  if (!device_id) {
    return NextResponse.json({ ok: false, reason: "no_device" });
  }

  const token = await getDeviceFcmToken(device_id).catch(() => null);
  if (!token) {
    return NextResponse.json({
      ok: false,
      reason: "no_token",
      device_id,
      hint: "phone ne /api/devices/token se FCM token register nahi kiya",
    });
  }
  if (!fcmConfigured()) {
    return NextResponse.json({
      ok: false,
      reason: "fcm_not_configured",
      device_id,
    });
  }

  const title = String(body.title || "WhopClip");
  const pushBody = String(body.body || "Naya kaam aaya hai — app kholo aur sync karo.");
  const data: Record<string, string> = {};
  if (body.data && typeof body.data === "object") {
    for (const [k, v] of Object.entries(body.data as Record<string, unknown>)) {
      data[k] = String(v);
    }
  }
  const r = await sendPush(token, { title, body: pushBody, data });
  return NextResponse.json({
    ok: r.ok,
    reason: r.reason,
    messageId: r.messageId,
    device_id,
  });
}
