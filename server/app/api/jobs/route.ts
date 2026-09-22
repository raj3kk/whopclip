import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/lib/store";

/**
 * GET /api/jobs?device_id=... -> list this device's jobs (monitor)
 */
export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  return NextResponse.json({ jobs: await listJobs(device_id) });
}
