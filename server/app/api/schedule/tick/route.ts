import { NextRequest, NextResponse } from "next/server";
import {
  getSchedule,
  listDevices,
  markScheduleRun,
  scheduleDue,
} from "@/lib/store";
import { enqueueRunStep, RunError } from "@/lib/run";

/**
 * GET /api/schedule/tick — server cron (every 15 min via vercel.json).
 *
 * Auth: x-cron-secret header must equal CRON_SECRET env. If CRON_SECRET is
 * not configured the endpoint is unavailable (503) — see README "Schedule
 * cron" section.
 *
 * For every registered device whose schedule is due, enqueues a "check" run
 * (the start of the campaign pipeline) and marks the schedule run so it
 * fires once per day. This is the source of truth for scheduled automation;
 * the phone does not poll schedules in this version.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured (see README)" },
      { status: 503 }
    );
  }
  const given = req.headers.get("x-cron-secret");
  if (!given || given !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ran: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ device_id: string; error: string }> = [];

  let devices: Awaited<ReturnType<typeof listDevices>> = [];
  try {
    devices = await listDevices();
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "listDevices failed" },
      { status: 500 }
    );
  }

  for (const d of devices) {
    const schedule = await getSchedule(d.device_id);
    if (!scheduleDue(schedule)) {
      skipped.push(d.device_id);
      continue;
    }
    try {
      const { job } = await enqueueRunStep(d.device_id, "check");
      await markScheduleRun(d.device_id);
      ran.push(`${d.device_id}:${job.id}`);
    } catch (e: unknown) {
      if (e instanceof RunError && e.status === 409) {
        // e.g. no eligible campaign — not a hard failure, but don't mark run
        skipped.push(`${d.device_id} (no eligible campaign)`);
      } else {
        errors.push({
          device_id: d.device_id,
          error: e instanceof Error ? e.message : "unknown",
        });
      }
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    ran,
    skipped,
    errors,
    at: new Date().toISOString(),
  });
}
