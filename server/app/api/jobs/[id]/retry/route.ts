import { NextRequest, NextResponse } from "next/server";
import { getJob, requeueJob } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * POST /api/jobs/:id/retry (owner login)
 *
 * Requeues a failed job so the phone picks it up again on its next poll.
 * Only "failed" jobs can be retried — done jobs are never re-run blindly
 * (that could double-post or double-submit).
 */
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
  if (job.status !== "failed") {
    return NextResponse.json(
      { error: `only failed jobs can be retried (status: ${job.status})` },
      { status: 409 }
    );
  }
  const r = await requeueJob(job.id, `Retry (dashboard se): ${job.type}`);
  return NextResponse.json({ ok: true, job: r });
}
