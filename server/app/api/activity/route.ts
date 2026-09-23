import { NextRequest, NextResponse } from "next/server";
import { listActivity } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET /api/activity?device_id=...&limit=50 (owner login)
 *
 * Durable per-device event timeline: enqueued / claimed / done / failed /
 * cancelled / retried / requeued. The dashboard Live tab shows this under
 * the live frame — "phone ne kya kiya, kab kiya".
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const limit = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50, 1),
    200
  );
  const events = await listActivity(device_id, limit);
  return NextResponse.json({ events });
}
