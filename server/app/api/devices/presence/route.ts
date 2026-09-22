import { NextResponse } from "next/server";
import { setDevicePresence } from "@/lib/store";

/**
 * POST /api/devices/presence — phone's explicit online/offline toggle
 * from the Profile tab. Body: { device_id, online, app_version }.
 * No owner login needed (the phone calls this directly).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const device_id = String(body.device_id || "");
    const online = Boolean(body.online);
    if (!device_id) {
      return NextResponse.json({ error: "device_id required" }, { status: 400 });
    }
    await setDevicePresence(device_id, online);
    return NextResponse.json({ ok: true, online });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
