import { NextResponse } from "next/server";
import { getDevice, deviceOnline, listJobs, earningsSummary } from "@/lib/store";

/** Live device facts — never prerender (2026-09-23: static prerender served
 *  a frozen last_seen for hours while the DB kept updating). */
export const dynamic = "force-dynamic";

/**
 * GET /api/devices/[id]/status — what the phone's Profile tab shows after
 * pairing: the same device facts the website dashboard shows (status,
 * last seen, earnings, jobs today). No owner login (phone calls it).
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const device_id = params.id;
  if (!device_id) {
    return NextResponse.json({ error: "device id required" }, { status: 400 });
  }
  const d = await getDevice(device_id);
  if (!d) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }
  const online = deviceOnline(d);
  const jobs = await listJobs(device_id);
  const today = new Date().toISOString().slice(0, 10);
  const jobsToday = jobs.filter((j) => (j.created_at || "").slice(0, 10) === today).length;
  let earnings = "";
  try {
    const e = await earningsSummary(device_id);
    earnings = `$${e?.total_earned_usd ?? 0}`;
  } catch { /* optional */ }
  return NextResponse.json({
    device_id: d.device_id,
    status: online ? "online" : "offline",
    last_seen: d.last_poll_at,
    paired_at: d.paired_at,
    app_version: d.app_version,
    device_model: d.device_model,
    jobs_today: String(jobsToday),
    earnings,
  });
}
