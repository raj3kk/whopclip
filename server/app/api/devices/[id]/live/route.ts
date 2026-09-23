import { NextRequest, NextResponse } from "next/server";
import { getDevice, getLiveFrame, listJobs } from "@/lib/store";

/**
 * GET /api/devices/[id]/live — device-accessible live snapshot for the
 * phone's own Live tab (no owner login; the phone calls this itself).
 * Returns the latest live frame pointer + the currently running job's
 * progress. The app shows the screenshot on top, job history below.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const device_id = params.id;
  if (!device_id) {
    return NextResponse.json({ error: "device id required" }, { status: 400 });
  }
  const device = await getDevice(device_id);
  if (!device) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }
  const [live, jobs] = await Promise.all([
    getLiveFrame(device_id),
    listJobs(device_id),
  ]);
  const running = jobs.find((j) => j.status === "running") ?? null;
  return NextResponse.json(
    {
      live,
      running_job: running
        ? {
            id: running.id,
            type: running.type,
            current_step: running.current_step ?? null,
            heartbeat_count: running.heartbeat_count ?? 0,
            last_heartbeat: running.last_heartbeat ?? null,
            steps_total: running.steps.length,
            cancel_requested: running.cancel_requested === true,
            updated_at: running.updated_at,
          }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
