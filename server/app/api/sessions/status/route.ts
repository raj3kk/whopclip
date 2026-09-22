import { NextRequest, NextResponse } from "next/server";
import { sessionStatus } from "@/lib/store";

/**
 * GET /api/sessions/status?device_id=...
 * Checkpoint 10 — phone checks this; any service with stale:true means
 * the user must re-login in the app (MainActivity shows the prompt).
 */
export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  return NextResponse.json({ device_id, services: sessionStatus(device_id) });
}
