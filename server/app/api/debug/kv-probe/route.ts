import { NextResponse } from "next/server";

/**
 * TEMPORARY DEBUG — kv write observability. DELETE AFTER USE.
 * Replicates lib/db.ts sb() PATCH-then-POST sequence against flipify_kv
 * and reports raw statuses + read-back, so we can see where the device
 * presence write gets lost.
 */
const SB_URL =
  process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DEVICE = "whopclip";

async function raw(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; bodyLen: number; bodyHead: string }> {
  const res = await fetch(`${SB_URL}${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, bodyLen: text.length, bodyHead: text.slice(0, 200) };
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") || "device:probe-test";
  const full = `whopclip:${key}`;
  const filter = `device_id=eq.${DEVICE}&key=eq.${encodeURIComponent(full)}`;
  const out: Record<string, unknown> = {
    keyLen: SB_KEY.length,
    urlHost: new URL(SB_URL).host,
  };
  try {
    // 1. read current
    const g1 = await raw("GET", `/rest/v1/flipify_kv?${filter}&select=value,updated_at`);
    out.get1 = g1;
    let parsed: unknown = null;
    try { parsed = JSON.parse(g1.bodyHead); } catch { /* truncated head */ }
    out.get1_rows = Array.isArray(parsed) ? parsed.length : "n/a";
    // 2. PATCH
    const marker = `probe-${Date.now()}`;
    const p = await raw("PATCH", `/rest/v1/flipify_kv?${filter}`, {
      value: { marker },
      updated_at: new Date().toISOString(),
    });
    out.patch = p;
    // 3. POST (only what kv.set would do if patch returned 0 rows)
    let post: unknown = "skipped";
    try {
      const pj = JSON.parse(p.bodyHead);
      if (p.status === 200 && Array.isArray(pj) && pj.length === 0) {
        post = await raw("POST", `/rest/v1/flipify_kv`, {
          device_id: DEVICE, key: full,
          value: { marker }, updated_at: new Date().toISOString(),
        });
      }
    } catch { post = "parse-failed"; }
    out.post = post;
    // 4. read back
    const g2 = await raw("GET", `/rest/v1/flipify_kv?${filter}&select=value`);
    out.get2 = { status: g2.status, bodyLen: g2.bodyLen, bodyHead: g2.bodyHead.slice(0, 300) };
  } catch (e) {
    out.error = String(e);
  }
  return NextResponse.json(out);
}
