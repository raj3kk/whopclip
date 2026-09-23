import { NextRequest, NextResponse } from "next/server";
import { cancelJob, getJob } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * POST /api/jobs/:id/cancel (owner login)
 *
 * Stops a job: queued jobs are cancelled immediately; running jobs get
 * cancel_requested=true and the phone aborts on its next heartbeat
 * (dashboard shows "cancel requested ⏳" meanwhile). Terminal jobs
 * (done/failed/cancelled) return 409 — they are never re-run or touched.
 */
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const job = await getJob(params.id);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return NextResponse.json(
      { error: `job already ${job.status} — cannot cancel` },
      { status: 409 }
    );
  }
  const updated = await cancelJob(job.id);
  return NextResponse.json({ ok: true, job: updated });
}
