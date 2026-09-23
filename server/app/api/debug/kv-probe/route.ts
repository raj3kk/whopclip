import { NextResponse } from "next/server";
import { getDevice } from "@/lib/store";

/** TEMPORARY DEBUG — compares store.ts getDevice vs raw REST. DELETE AFTER USE. */
const SB_URL =
  process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const device_id =
    url.searchParams.get("device_id") ||
    "b5cce48d-cf27-4bcb-b9fe-3c0416ed71fc";
  // one-off restore of the device row clobbered by the earlier probe PATCH
  if (url.searchParams.get("restore") === "1") {
    const full = `whopclip:device:${device_id}`;
    const cur = await fetch(
      `${SB_URL}/rest/v1/flipify_kv?device_id=eq.whopclip&key=eq.${encodeURIComponent(full)}&select=value`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    ).then((r) => r.json());
    const curV = (cur[0]?.value ?? {}) as Record<string, unknown>;
    const restored = {
      device_id,
      paired_at: "2026-09-23T04:31:15.532Z",
      app_version: curV.app_version ?? "14",
      device_model: curV.device_model ?? "vivo V2240",
      last_poll_at: curV.last_poll_at ?? null,
      presence: curV.presence ?? "offline",
    };
    const res = await fetch(
      `${SB_URL}/rest/v1/flipify_kv?device_id=eq.whopclip&key=eq.${encodeURIComponent(full)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          value: restored,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    return NextResponse.json({ restored, patchStatus: res.status });
  }
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
