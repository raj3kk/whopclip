import { NextRequest, NextResponse } from "next/server";
import { requeueStuckJobs } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * POST /api/jobs/requeue-stuck (owner login)
 * Body: { device_id }
 *
 * Manual stuck-job recovery: requeues "running" jobs whose heartbeat died
 * more than 10 minutes ago (same rule the daily schedule tick applies).
 * Use from the dashboard Phone tab when a job looks dead.
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const device_id = typeof body?.device_id === "string" ? body.device_id : "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const requeued = await requeueStuckJobs(device_id);
  return NextResponse.json({
    ok: true,
    requeued: requeued.map((j) => ({ id: j.id, type: j.type })),
  });
}
