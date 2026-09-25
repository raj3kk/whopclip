/**
 * Turso (Hrana) KV client for WhopClip — MeraBackend Phase 0 cutover.
 *
 * Speaks the Hrana `/v2/pipeline` HTTPS protocol directly (no native
 * driver; Vercel serverless-safe, pure fetch).
 *
 * Schema (created by kv/load_export.py):
 *   CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)
 * `value` is JSON text; `updated_at` is an ISO-8601 version string produced
 * by nextVersion() (same CAS protocol as the Supabase backend in db.ts).
 * Keys are stored EXACTLY as passed (the caller prefixes `whopclip:`).
 *
 * Auth: TURSO_HOST (default whop-raj3kk.aws-ap-south-1.turso.io) and
 * TURSO_AUTH_TOKEN (Vercel env, never in code). When the token is absent,
 * tursoEnabled=false and callers fall back to the Supabase backend.
 */

import { nextVersion, type KVBackendEx } from "./db";

const TURSO_HOST =
  process.env.TURSO_HOST ?? "whop-raj3kk.aws-ap-south-1.turso.io";
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN ?? "";

export const tursoEnabled = TURSO_HOST.length > 0 && TURSO_TOKEN.length > 0;

type HranaArg =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; value: string };

function toHranaArg(v: unknown): HranaArg {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number")
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: v };
  return { type: "text", value: String(v) };
}

function fromHranaVal(cell: { type: string; value?: unknown }): unknown {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "integer") return parseInt(String(cell.value), 10);
  if (cell.type === "float") return Number(cell.value);
  return cell.value ?? null;
}

interface HranaResult {
  cols: string[];
  rows: unknown[][];
  rows_affected: number;
}

async function pipeline(
  statements: Array<{ sql: string; args: unknown[] }>
): Promise<HranaResult[]> {
  if (!tursoEnabled) throw new Error("turso not configured (TURSO_AUTH_TOKEN missing)");
  // Manual AbortController + setTimeout: AbortSignal.timeout() rejects with
  // TimeoutError, which some clients treat as retryable; a real abort is
  // unambiguous (AGENTS.md lesson 2026-09-24).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`https://${TURSO_HOST}/v2/pipeline`, {
      method: "POST",
      cache: "no-store",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TURSO_TOKEN}`,
      },
      body: JSON.stringify({
        requests: statements.map((s) => ({
          type: "execute",
          stmt: { sql: s.sql, args: s.args.map(toHranaArg) },
        })),
      }),
    });
    const text = await res.text();
    let data: {
      results?: Array<{
        type: string;
        error?: unknown;
        response?: {
          result?: {
            cols?: Array<{ name?: string }>;
            rows?: Array<Array<{ type: string; value?: unknown }>>;
            rows_affected?: number;
          };
        };
      }>;
    };
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`turso: non-JSON response HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`turso: HTTP ${res.status} ${text.slice(0, 200)}`);
    const out: HranaResult[] = [];
    for (const r of data.results ?? []) {
      if (r.type === "error")
        throw new Error(`turso statement error: ${JSON.stringify(r.error)}`);
      const result = r.response?.result ?? {};
      out.push({
        cols: (result.cols ?? []).map((c) => c.name ?? ""),
        rows: (result.rows ?? []).map((row) => row.map(fromHranaVal)),
        rows_affected: Number(result.rows_affected ?? 0),
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const UPSERT =
  `INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) ` +
  `ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`;

function ser(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function deser(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // defensive: non-JSON legacy value
  }
}

export interface TsRow {
  value: unknown;
  updated_at: string;
}

export async function tursoGetWithTs(key: string): Promise<TsRow | null> {
  const full = `whopclip:${key}`;
  const [r] = await pipeline([
    { sql: "SELECT value, updated_at FROM kv WHERE key = ?", args: [full] },
  ]);
  if (!r.rows.length) return null;
  const [raw, ts] = r.rows[0] as [unknown, unknown];
  return { value: deser(raw), updated_at: String(ts ?? "") };
}

export const tursoKV: KVBackendEx = {
  async getWithTs(key: string) {
    return tursoGetWithTs(key);
  },

  async get(key: string) {
    const full = `whopclip:${key}`;
    const [r] = await pipeline([
      { sql: "SELECT value FROM kv WHERE key = ?", args: [full] },
    ]);
    if (!r.rows.length) return null;
    return deser(r.rows[0][0]) ?? null;
  },

  async set(key: string, value: unknown) {
    const full = `whopclip:${key}`;
    if (value === null || value === undefined) {
      // Clear semantics: null/undefined deletes the row (no tombstones).
      // Both backends agree — keeps dual-write reconcile clean.
      await pipeline([{ sql: "DELETE FROM kv WHERE key = ?", args: [full] }]);
      return;
    }
    await pipeline([{ sql: UPSERT, args: [full, ser(value), nextVersion()] }]);
  },

  async cas(key: string, value: unknown, updatedAt: string) {
    const full = `whopclip:${key}`;
    const [r] = await pipeline([
      {
        sql: "UPDATE kv SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?",
        args: [ser(value), nextVersion(), full, updatedAt],
      },
    ]);
    return r.rows_affected > 0;
  },
};

/** Liveness probe for the reconcile/health endpoints. */
export async function tursoHealth(): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const [r] = await pipeline([{ sql: "SELECT 1 AS ok", args: [] }]);
    return { ok: r.rows[0]?.[0] === 1, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false, latencyMs: Date.now() - t0 };
  }
}

/** All keys in the kv table (for the reconcile endpoint). */
export async function tursoListKeys(): Promise<string[]> {
  const [r] = await pipeline([{ sql: "SELECT key FROM kv ORDER BY key", args: [] }]);
  return r.rows.map((row) => String(row[0]));
}
