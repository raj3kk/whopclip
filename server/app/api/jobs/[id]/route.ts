import { NextRequest, NextResponse } from "next/server";
import {
  alreadySubmitted,
  enqueueJob,
  finishJob,
  getCampaign,
  getJob,
  markSessionStale,
  recordSubmission,
  requeueJob,
  type Job,
  type JobStatus,
  type ServiceName,
} from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { onJobDone, onJobFailed } from "@/lib/chain";
import crypto from "crypto";

/**
 * POST /api/jobs/enqueue -> orchestrator enqueues { device_id, type, steps, campaign_id? }
 * POST /api/jobs/:id    -> phone reports:
 *    { status:"done"|"failed", result } |
 *    { status:"requeue" }                       (e.g. upload needs foreground)
 *    result.session_expired=true + result.service -> marks that session stale
 *    (checkpoint 10)
 *    whop_submit done + result.campaign_id/ig_post_url -> records submission
 *    (checkpoints 1 + 9: duplicate prevention + earnings ledger)
 * GET  /api/jobs?device_id= -> see app/api/jobs/route.ts (list jobs for a device)
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (params.id === "enqueue") {
    // Orchestrator-only: owner dashboard uses authed /api/run; raw HTTP
    // enqueue must not be callable by the phone or anyone else.
    if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
      return NextResponse.json({ error: "login required" }, { status: 401 });
    }
    try {
      const body = await req.json();
      const { device_id, type, steps } = body ?? {};
      if (!device_id || !type || !Array.isArray(steps)) {
        return NextResponse.json(
          { error: "device_id, type, steps[] required" }, { status: 400 });
      }
      const now = new Date().toISOString();
      const job: Job = {
        id: crypto.randomUUID(),
        device_id,
        type,
        status: "queued",
        steps,
        result: null,
        created_at: now,
        updated_at: now,
      };
      await enqueueJob(job);
      return NextResponse.json({ ok: true, job });    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
    }
  }

  try {
    const body = await req.json();
    const { status, result } = body ?? {};

    if (status === "requeue") {
      const job = await requeueJob(params.id, "Phone ne requeue manga");
      if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
      return NextResponse.json({ ok: true, job });
    }

    if (status !== "done" && status !== "failed" && status !== "cancelled") {
      return NextResponse.json({ error: "status must be done|failed|cancelled|requeue" }, { status: 400 });
    }

    // Soft device-ownership check: the phone always sends its device_id;
    // a report for another device's job is rejected (spoof-proofing).
    // Older app versions that don't send device_id keep working.
    const reporter = typeof body?.device_id === "string" ? body.device_id : "";
    {
      const job0 = await getJob(params.id);
      if (job0 && reporter && job0.device_id !== reporter) {
        return NextResponse.json({ error: "job belongs to another device" }, { status: 403 });
      }
    }

    // Checkpoint 10: session expired -> flag for re-login prompt.
    const r = (result ?? {}) as Record<string, unknown>;
    if (r.session_expired === true && (r.service === "whop" || r.service === "instagram")) {
      const job0 = await finishJob(params.id, status as JobStatus, result ?? null);
      await markSessionStale(job0?.device_id ?? "", r.service as ServiceName);
      return NextResponse.json({ ok: true, job: job0, session_stale: r.service });
    }

    const job = await finishJob(params.id, status as JobStatus, result ?? null);
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

    // Checkpoints 1+9: successful Whop submit -> earnings ledger (dup-proof).
    // campaign_id usually comes from the phone's extract result, but the
    // orchestrator also stamps it on the job — fall back to the job field
    // so submissions are recorded (and alreadySubmitted() works) even when
    // the phone doesn't send campaign_id back.
    if (job.type === "whop_submit" && status === "done") {
      const campaign_id =
        typeof r.campaign_id === "string" && r.campaign_id
          ? r.campaign_id
          : typeof job.campaign_id === "string"
            ? job.campaign_id
            : "";
      const ig_post_url = typeof r.ig_post_url === "string" ? r.ig_post_url : "";
      if (campaign_id && ig_post_url && !(await alreadySubmitted(job.device_id, campaign_id))) {
        const camp = await getCampaign(campaign_id);
        const now = new Date().toISOString();
        await recordSubmission({
          id: crypto.randomUUID(),
          device_id: job.device_id,
          campaign_id,
          campaign_name: camp?.name ?? campaign_id,
          ig_post_url,
          status: "submitted",
          payout_per_1k: camp?.payout_per_1k ?? 0,
          views: null,
          earned_usd: null,
          created_at: now,
        });
      }
    }

    // Chain engine: advance the campaign pipeline when a staged job finishes.
    // Runs after submission recording so the chain sees the final state.
    // Failures inside the chain engine must never break job reporting.
    // Cancelled jobs skip the chain entirely — owner intent, not a result.
    try {
      if (status === "done") {
        await onJobDone(job);
      } else if (status === "failed") {
        await onJobFailed(job);
      }
    } catch (e: unknown) {
      console.error("[chain] advance error:", e instanceof Error ? e.message : e);
    }

    return NextResponse.json({ ok: true, job });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}
