import { NextRequest, NextResponse } from "next/server";
import { getDevice, heartbeatJob } from "@/lib/store";

/**
 * POST /api/jobs/:id/heartbeat { device_id, current_step }
 *
 * The phone pings this every ~30s while a job is running, reporting which
 * step it's on (e.g. "goto whop_url", "extract join_state", "upload frame_7s").
 * The dashboard shows live progress; the schedule tick requeues jobs whose
 * heartbeat goes stale (>10 min) so a dead phone never blocks the pipeline.
 *
 * Auth: device_id must match a registered device that owns the job.
 */
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const current_step =
      typeof body?.current_step === "string" ? body.current_step : "";
    if (!device_id || !current_step) {
      return NextResponse.json(
        { error: "device_id and current_step required" },
        { status: 400 }
      );
    }
    const device = await getDevice(device_id);
    if (!device) {
      return NextResponse.json({ error: "unknown device" }, { status: 403 });
    }
    const job = await heartbeatJob(params.id, current_step);
    if (!job) {
      return NextResponse.json(
        { error: "job not found or not running" },
        { status: 404 }
      );
    }
    if (job.device_id !== device_id) {
      return NextResponse.json({ error: "job belongs to another device" }, { status: 403 });
    }
    return NextResponse.json({
      ok: true,
      current_step: job.current_step,
      heartbeat_count: job.heartbeat_count,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
