import { NextRequest, NextResponse } from "next/server";
import { claimJob, touchDevice } from "@/lib/store";

/**
 * GET /api/jobs/next?device_id=...
 * Phone long-polls this. Returns { job } or 204 when the queue is empty.
 * Claiming is atomic (CAS on updated_at) so two pollers never run the same job.
 */
export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  // heartbeat: dashboard "phone status" reads this
  touchDevice(device_id, {
    app_version: req.nextUrl.searchParams.get("app_version") ?? undefined,
    device_model: req.nextUrl.searchParams.get("device_model") ?? undefined,
  }).catch(() => {});
  const job = await claimJob(device_id);
  if (!job) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ job });
}
