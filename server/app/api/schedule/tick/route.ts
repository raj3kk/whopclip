import { NextRequest, NextResponse } from "next/server";
import {
  getSchedule,
  listDevices,
  markScheduleRun,
  requeueStuckJobs,
  scheduleDue,
} from "@/lib/store";
import { enqueueRunStep, RunError } from "@/lib/run";

/**
 * GET /api/schedule/tick — server cron (daily via vercel.json; Hobby plan
 * allows only one cron run per day).
 *
 * Auth: the request must carry the cron secret, either as the
 * `x-cron-secret` header or as `Authorization: Bearer <secret>`.
 * Vercel's own scheduler invokes this path from vercel.json; external
 * callers (e.g. a manual trigger script) use the same headers.
 * If CRON_SECRET is not configured the endpoint is unavailable (503).
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
  const given =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
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
    // Stuck-job recovery first: requeue jobs whose heartbeat died >10 min
    // ago so a dead phone never blocks the pipeline.
    try {
      const stuck = await requeueStuckJobs(d.device_id);
      for (const j of stuck) ran.push(`${d.device_id}:${j.id} (requeued stuck ${j.type})`);
    } catch (e: unknown) {
      errors.push({
        device_id: d.device_id,
        error: `stuck-recovery: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
    const schedule = await getSchedule(d.device_id);
    if (!scheduleDue(schedule)) {
      skipped.push(d.device_id);
      continue;
    }
    try {
      const { job, campaign, chain } = await enqueueRunStep(d.device_id, "full");
      await markScheduleRun(d.device_id);
      ran.push(
        campaign
          ? `${d.device_id}:${job.id} (chain ${chain?.id ?? "?"}, ${campaign.name})`
          : `${d.device_id}:${job.id} (discovering campaigns)`
      );
    } catch (e: unknown) {
      if (e instanceof RunError && e.status === 409) {
        // e.g. explicit campaign_id not found — not a hard failure
        skipped.push(`${d.device_id} (${e.message})`);
      } else if (e instanceof Error && /already (active|submitted)/i.test(e.message)) {
        // startChain fail-closed: a chain is already running or this
        // campaign was submitted — correct to skip, not an error.
        skipped.push(`${d.device_id} (${e.message})`);
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
