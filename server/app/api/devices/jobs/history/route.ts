import { NextResponse } from "next/server";
import { listJobs } from "@/lib/store";

/**
 * GET /api/devices/jobs/history?device_id=… — recent job runs for the
 * phone's Live tab (automation history). No owner login (phone calls it).
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const device_id = u.searchParams.get("device_id") || "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const jobs = await listJobs(device_id);
  const out = jobs.slice(0, 20).map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    current_step: (j as { current_step?: string }).current_step || "",
    created_at: j.created_at,
  }));
  return NextResponse.json({ jobs: out });
}
