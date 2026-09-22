import { NextRequest, NextResponse } from "next/server";
import { enqueueJob, finishJob, listJobs, type Job, type JobStatus } from "@/lib/store";
import crypto from "crypto";

/**
 * POST /api/jobs/:id        -> phone reports { status: "done"|"failed", result }
 * POST /api/jobs/enqueue    -> orchestrator enqueues { device_id, type, steps }
 * GET  /api/jobs?device_id= -> list jobs for a device (debug/monitor)
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (params.id === "enqueue") {
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
      enqueueJob(job);
      return NextResponse.json({ ok: true, job });
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
    }
  }

  try {
    const body = await req.json();
    const { status, result } = body ?? {};
    if (status !== "done" && status !== "failed") {
      return NextResponse.json({ error: "status must be done|failed" }, { status: 400 });
    }
    const job = finishJob(params.id, status as JobStatus, result ?? null);
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
    return NextResponse.json({ ok: true, job });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  return NextResponse.json({ jobs: listJobs(device_id) });
}
