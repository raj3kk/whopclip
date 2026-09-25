import { NextRequest, NextResponse } from "next/server";
import {
  getLiveFrame,
  clearLiveFrame,
  listJobs,
  LIVE_FRAME_TTL_MS,
  type LiveFrame,
} from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET /api/live?device_id= (owner login)
 *
 * "Phone abhi kya kar raha hai": the latest live frame the phone uploaded
 * (downscaled WebView screenshot after every job step) plus the currently
 * running job's progress. The dashboard Live tab polls this every 5s and
 * shows the frame on top, job history below.
 *
 * Lazy expiry (user rule): frames older than LIVE_FRAME_TTL_MS (10 min)
 * are deleted here — storage object + KV pointer — so screenshots never
 * accumulate. The dashboard already polls every 5s, so expiry lands on
 * the next read after the TTL without any cron.
 */
export const dynamic = "force-dynamic";

const SB_URL =
  process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = "whopclip";

function objectPathFromUrl(frame_url: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const i = frame_url.indexOf(marker);
  if (i < 0) return null;
  const p = frame_url.slice(i + marker.length);
  return p && !p.includes("..") ? p : null;
}

async function deleteFrameObject(frame_url: string): Promise<void> {
  const path = objectPathFromUrl(frame_url);
  if (!path || !SB_KEY) return;
  await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "DELETE",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
    },
  }).catch(() => {});
}

async function expireIfStale(
  device_id: string,
  live: LiveFrame | null
): Promise<LiveFrame | null> {
  if (!live) return null;
  const age = Date.now() - new Date(live.updated_at).getTime();
  if (!(age > LIVE_FRAME_TTL_MS)) return live;
  // 10 min se purana — storage object + pointer dono delete (best-effort).
  await deleteFrameObject(live.frame_url);
  await clearLiveFrame(device_id).catch(() => {});
  return null;
}

export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const [rawLive, jobs] = await Promise.all([
    getLiveFrame(device_id),
    listJobs(device_id),
  ]);
  const live = await expireIfStale(device_id, rawLive);
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
