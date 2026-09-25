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
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
    // read while worker ticks piled up; Supabase partial degradation made
    // flipify_kv queries hang). 12s is generous for KV ops (<1s normal) and
    // well under Vercel maxDuration=30, so routes return a clean 500 JSON
    // instead of FUNCTION_INVOCATION_TIMEOUT.
    signal: AbortSignal.timeout(12_000),
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

/**
 * Extended backend with a raw row read (value + updated_at) for CAS flows.
 * Both the Supabase and Turso backends implement this.
 */
export interface KVBackendEx extends KVBackend {
  getWithTs(key: string): Promise<{ value: unknown; updated_at: string } | null>;
}

/* ---------------- cutover config (Phase 0) ----------------
 * KV_READ_SOURCE: "supabase" (default) | "turso" — which backend serves reads.
 * KV_WRITE_MODE:  "supabase" (default) | "dual" | "turso".
 *   dual = write the read-source backend, then propagate to the other one.
 * Rollback = set both back to "supabase" (today's exact behavior).
 * NOTE: tursoKV lives in ./turso.ts (separate module to keep the import
 * graph acyclic: turso.ts imports nextVersion/KVBackend from here).
 */
export type KVReadSource = "supabase" | "turso";
export type KVWriteMode = "supabase" | "dual" | "turso";

export function kvReadSource(): KVReadSource {
  return process.env.KV_READ_SOURCE === "turso" ? "turso" : "supabase";
}

export function kvWriteMode(): KVWriteMode {
  const m = process.env.KV_WRITE_MODE;
  return m === "dual" || m === "turso" ? m : "supabase";
}

/**
 * Dual-write wrapper: reads always come from `read`; every write also goes
 * to each secondary. A secondary failure is logged loudly but never breaks
 * the request (the read source is the source of truth; /api/internal/kv-reconcile
 * reports drift). CAS propagation: after winning the primary CAS, propagate
 * via the secondary's own getWithTs+cas, falling back to a plain set — safe
 * because every writer goes through this same path (a primary-CAS loser never
 * writes anywhere).
 */
export function dualKV(read: KVBackendEx, secondaries: KVBackendEx[]): KVBackend {
  return {
    async get(key: string) {
      return read.get(key);
    },
    async set(key: string, value: unknown) {
      await read.set(key, value);
      for (const s of secondaries) {
        try {
          await s.set(key, value);
        } catch (e) {
          console.error(`[kv] dual-write secondary set failed key=${key}`, e);
        }
      }
    },
    async cas(key: string, value: unknown, updatedAt: string) {
      const ok = await read.cas(key, value, updatedAt);
      if (!ok) return false;
      for (const s of secondaries) {
        try {
          const row = await s.getWithTs(key);
          let done = row ? await s.cas(key, value, row.updated_at) : false;
          if (!done) await s.set(key, value); // lost secondary race — converge
        } catch (e) {
          console.error(`[kv] dual-write secondary cas failed key=${key}`, e);
        }
      }
      return true;
    },
  };
}

export const supabaseKV: KVBackendEx = {
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
    if (value === null || value === undefined) {
      // Clear semantics: null/undefined deletes the row (no tombstones).
      // Both backends agree — keeps dual-write reconcile clean.
      await sb("DELETE", `/rest/v1/flipify_kv?${filter}`);
      return;
    }
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

  /** Raw row read (value + updated_at) for CAS flows. */
  async getWithTs(key: string) {
    const full = `whopclip:${key}`;
    const { status, json } = await sb(
      "GET",
      `/rest/v1/flipify_kv?device_id=eq.${DEVICE}&key=eq.${encodeURIComponent(full)}&select=value,updated_at`
    );
    if (status !== 200 || !Array.isArray(json) || json.length === 0) return null;
    const row = json[0] as { value: unknown; updated_at: string };
    return { value: row.value ?? null, updated_at: row.updated_at };
  },
};
