import { NextResponse } from "next/server";
import { disconnectDevice } from "@/lib/store";

/**
 * POST /api/devices/disconnect — full unpair from the phone's Profile tab.
 * Body: { device_id }. Server drops the device registration; the phone
 * wipes its local pairing state. Re-pair requires a fresh code.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const device_id = String(body.device_id || "");
    if (!device_id) {
      return NextResponse.json({ error: "device_id required" }, { status: 400 });
    }
    await disconnectDevice(device_id);
    return NextResponse.json({ ok: true, disconnected: true });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
