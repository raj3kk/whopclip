/**
 * Durable key-value client on the existing Supabase `flipify_kv` table
 * (columns: device_id, key, value, updated_at). All WhopClip keys are
 * namespaced `whopclip:` so they never collide with Flipify rows.
 *
 * Auth: SUPABASE_URL (defaults to the project's known host) and
 * SUPABASE_SERVICE_ROLE_KEY (Vercel env, never in code).
 * When the key is absent, dbEnabled=false and the caller falls back to
 * the in-memory store (dev / pre-provisioned mode).
 */

const SB_URL =
  process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export const dbEnabled = SB_URL.length > 0 && SB_KEY.length > 0;

const DEVICE = "whopclip";

/**
 * Unique version token for CAS writes. ISO-8601 with random microsecond
 * digits appended — unique per write even when two writers land in the same
 * millisecond, so a conditional-PATCH compare-and-set can never double-win.
 * (Plain `new Date().toISOString()` only has ms precision: two concurrent
 * writers in the same ms would stamp the SAME version and both CAS calls
 * would match.) Valid for timestamptz and text columns; still parses as a
 * date wherever it is displayed.
 */
export function nextVersion(): string {
  const iso = new Date().toISOString();
  const micro = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return iso.replace(/(\.\d{3})Z$/, `$1${micro}Z`);
}

async function sb(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${SB_URL}${path}`, {
    method,
    // Never let Next's data cache serve a stale device/session/job read:
    // the phone's status screen and the automation loop depend on fresh DB
    // values every request (2026-09-23: frozen status for hours).
    cache: "no-store",
    // Fail fast: a stalled Supabase REST call must never hang a route
    // indefinitely (2026-09-24: /api/render/next hung 1h+ on a stalled KV
    // read while worker ticks piled up). 30s is generous for KV ops.
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export interface KVBackend {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  /** Optimistic-lock write: only writes if updated_at still matches. */
  cas(key: string, value: unknown, updatedAt: string): Promise<boolean>;
}

export const supabaseKV: KVBackend = {
  async get(key: string) {
    const full = `whopclip:${key}`;
    const { status, json } = await sb(
      "GET",
      `/rest/v1/flipify_kv?device_id=eq.${DEVICE}&key=eq.${encodeURIComponent(full)}&select=value`
    );
    if (status !== 200 || !Array.isArray(json) || json.length === 0) return null;
    return (json[0] as { value: unknown }).value ?? null;
  },

  async set(key: string, value: unknown) {
    const full = `whopclip:${key}`;
    const now = nextVersion();
    const filter = `device_id=eq.${DEVICE}&key=eq.${encodeURIComponent(full)}`;
    // NOTE (2026-09-22): PostgREST upsert (?on_conflict=device_id,key) 409s
    // on this project's flipify_kv because there is no UNIQUE(device_id,key)
    // constraint. So: PATCH-then-POST. PATCH updates the existing row when
    // the key exists; POST inserts when it does not. If a concurrent writer
    // wins the race between our PATCH and POST, retry the PATCH once.
    const upd = await sb(
      "PATCH",
      `/rest/v1/flipify_kv?${filter}`,
      { value: value as Record<string, unknown>, updated_at: now }
    );
    if (upd.status === 200 && Array.isArray(upd.json) && upd.json.length > 0) return;
    if (upd.status !== 200) {
      throw new Error(`kvSet patch failed: ${upd.status}`);
    }
    const ins = await sb("POST", `/rest/v1/flipify_kv`, {
      device_id: DEVICE,
      key: full,
      value: value as Record<string, unknown>,
      updated_at: now,
    });
    if (ins.status === 200 || ins.status === 201) return;
    if (ins.status === 409) {
      // lost a write race — the row exists now, patch it
      const retry = await sb(
        "PATCH",
        `/rest/v1/flipify_kv?${filter}`,
        { value: value as Record<string, unknown>, updated_at: now }
      );
      if (retry.status === 200) return;
      throw new Error(`kvSet race-retry failed: ${retry.status}`);
    }
    throw new Error(`kvSet failed: ${ins.status}`);
  },

  async cas(key: string, value: unknown, updatedAt: string) {
    const full = `whopclip:${key}`;
    const payload = {
      value: value as Record<string, unknown>,
      updated_at: nextVersion(),
    };
    const { status, json } = await sb(
      "PATCH",
      `/rest/v1/flipify_kv?device_id=eq.${DEVICE}&key=eq.${encodeURIComponent(full)}&updated_at=eq.${encodeURIComponent(updatedAt)}`,
      payload
    );
    if (status !== 200) return false;
    return Array.isArray(json) && json.length > 0;
  },
};
