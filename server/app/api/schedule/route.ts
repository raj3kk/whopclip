import { NextRequest, NextResponse } from "next/server";
import { getSchedule, setSchedule, scheduleDue } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET  /api/schedule?device_id=... -> { schedule, due }
 * POST /api/schedule { device_id, enabled, time:"HH:MM", timezone } (owner login)
 *
 * The phone's poll loop reads GET and starts a check_join run when due=true
 * (then calls mark via POST { action:"ran" } so it fires once per day).
 */
export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const schedule = await getSchedule(device_id);
  return NextResponse.json({ schedule, due: scheduleDue(schedule) });
}

export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    if (!device_id) {
      return NextResponse.json({ error: "device_id required" }, { status: 400 });
    }
    if (body?.action === "ran") {
      const { markScheduleRun } = await import("@/lib/store");
      await markScheduleRun(device_id);
      return NextResponse.json({ ok: true });
    }
    const time = typeof body?.time === "string" ? body.time : "09:00";
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
    }
    const timezone =
      typeof body?.timezone === "string" && body.timezone ? body.timezone : "Asia/Calcutta";
    const prev = await getSchedule(device_id);
    const schedule = await setSchedule({
      device_id,
      enabled: body?.enabled !== false,
      time,
      timezone,
      last_run_date: prev.last_run_date,
    });
    return NextResponse.json({ ok: true, schedule, due: scheduleDue(schedule) });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
