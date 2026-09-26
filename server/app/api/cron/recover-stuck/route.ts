import { NextRequest, NextResponse } from "next/server";
import { requeueStuckJobs, listDevices } from "@/lib/store";

/**
 * GET /api/cron/recover-stuck
 *
 * Server-side stuck-job recovery — runs INDEPENDENTLY of phone polls.
 *
 * Root cause (2026-09-27): requeueStuckJobs() only ran inside
 * /api/jobs/next, i.e. only when the phone polled. When the phone went
 * silent (WorkManager killed, app crashed), stuck "running" jobs stayed
 * stuck forever — no poll = no recovery. This cron requeues them even
 * with zero phone activity.
 *
 * Auth: CRON_SECRET bearer (Vercel cron) — same as /api/schedule/tick.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const devices = await listDevices();
    let total = 0;
    const per_device: Record<string, number> = {};
    for (const d of devices) {
      const rq = await requeueStuckJobs(d.device_id);
      if (rq.length > 0) {
        per_device[d.device_id] = rq.length;
        total += rq.length;
      }
    }
    return NextResponse.json({ ok: true, requeued: total, per_device });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "failed" }, { status: 500 });
  }
}
