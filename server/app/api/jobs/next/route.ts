import { NextRequest, NextResponse } from "next/server";
import { claimJob, requeueStuckJobs, touchDevice } from "@/lib/store";

/**
 * GET /api/jobs/next?device_id=...
 * Phone long-polls this. Returns { job } or 204 when the queue is empty.
 * Claiming is atomic (CAS on updated_at) so two pollers never run the same job.
 *
 * Hybrid post-stage driver (2026-09-24): after marking the phone online,
 * check for chains parked at the post stage that need a phone upload job.
 * This ensures the job is enqueued even if /api/chains/advance is slow —
 * the phone gets its work on the same poll.
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

  // Stuck-job recovery on EVERY poll (fix 2026-09-25): a "running" job whose
  // heartbeat died >10 min ago is requeued here, so a dead phone/worker
  // never blocks the pipeline for 22h waiting for the daily tick. This runs
  // before claimJob so the same poll picks up the recovered job fresh.
  try {
    await requeueStuckJobs(device_id);
  } catch {
    /* non-fatal: claim path still works */
  }

  // Hybrid: enqueue pending post-stage phone jobs (fast path, no full pump).
  // This runs before claimJob so the phone picks up the upload on this poll.
  try {
    const { enqueuePendingPostJobs } = await import("@/lib/chain");
    await enqueuePendingPostJobs(device_id);
  } catch {
    /* non-fatal: job queue still works */
  }

  const job = await claimJob(device_id);
  if (!job) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ job });
}
