import { NextRequest, NextResponse } from "next/server";
import { earningsSummary } from "@/lib/store";

/**
 * GET /api/earnings?device_id=...
 * Checkpoint 9 — every submission recorded with campaign, payout rate,
 * status; totals computed server-side.
 */
export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  return NextResponse.json({ device_id, ...earningsSummary(device_id) });
}
