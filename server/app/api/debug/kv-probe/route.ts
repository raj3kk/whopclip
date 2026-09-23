import { NextResponse } from "next/server";
import { getDevice } from "@/lib/store";

/** TEMPORARY DEBUG — compares store.ts getDevice vs raw REST. DELETE AFTER USE. */
const SB_URL =
  process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export async function GET(req: Request) {
  const device_id =
    new URL(req.url).searchParams.get("device_id") ||
    "b5cce48d-cf27-4bcb-b9fe-3c0416ed71fc";
  const full = `whopclip:device:${device_id}`;
  const out: Record<string, unknown> = {};
  try {
    const viaStore = await getDevice(device_id);
    out.viaStore = viaStore
      ? {
          last_poll_at: (viaStore as any).last_poll_at ?? null,
          presence: (viaStore as any).presence ?? null,
          has_device_id: "device_id" in (viaStore as any),
          keys: Object.keys(viaStore as any),
        }
      : null;
  } catch (e) {
    out.viaStoreError = String(e);
  }
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flipify_kv?device_id=eq.whopclip&key=eq.${encodeURIComponent(full)}&select=value`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const arr = (await res.json()) as Array<{ value: any }>;
    out.viaRaw = {
      status: res.status,
      rowCount: arr.length,
      rows: arr.map((r) => ({
        last_poll_at: r.value?.last_poll_at ?? null,
        presence: r.value?.presence ?? null,
        keys: r.value ? Object.keys(r.value) : [],
      })),
    };
  } catch (e) {
    out.viaRawError = String(e);
  }
  return NextResponse.json(out);
}
