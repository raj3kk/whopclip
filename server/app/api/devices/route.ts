import { NextResponse } from "next/server";
import { listDevices, deviceOnline, getSchedule } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { cookies } from "next/headers";

/**
 * GET /api/devices (owner login) -> linked phones with online status + schedule
 */
export async function GET() {
  if (!verifyAuthToken(cookies().get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const devices = await listDevices();
  const out = [];
  for (const d of devices) {
    const schedule = await getSchedule(d.device_id);
    out.push({
      device_id: d.device_id,
      paired_at: d.paired_at,
      last_poll_at: d.last_poll_at,
      online: deviceOnline(d),
      app_version: d.app_version,
      device_model: d.device_model,
      schedule: {
        enabled: schedule.enabled,
        time: schedule.time,
        timezone: schedule.timezone,
        last_run_date: schedule.last_run_date,
      },
    });
  }
  return NextResponse.json({ devices: out });
}
