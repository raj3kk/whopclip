import { NextRequest, NextResponse } from "next/server";
import { getLiveFrame, listJobs } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET /api/live?device_id= (owner login)
 *
 * "Phone abhi kya kar raha hai": the latest live frame the phone uploaded
 * (downscaled WebView screenshot after every job step) plus the currently
 * running job's progress. The dashboard Live tab polls this every 5s and
 * shows the frame on top, job history below.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const [live, jobs] = await Promise.all([
    getLiveFrame(device_id),
    listJobs(device_id),
  ]);
  const running = jobs.find((j) => j.status === "running") ?? null;
  return NextResponse.json({
    live,
    running_job: running
      ? {
          id: running.id,
          type: running.type,
          current_step: running.current_step ?? null,
          heartbeat_count: running.heartbeat_count ?? 0,
          last_heartbeat: running.last_heartbeat ?? null,
          steps_total: running.steps.length,
          updated_at: running.updated_at,
        }
      : null,
  });
}
