import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/internal/kv-reconcile — Phase 0 Turso cutover verification.
 * Compares every `whopclip:*` key's value between the Supabase backend and
 * the Turso backend. Auth: x-cron-secret (CRON_SECRET). TEMPORARY: remove
 * once the cutover is complete and reads are on Turso.
 *
 * Query: ?prefix=whopclip:chain: (optional scope), ?concurrency=25
 * Returns: { ok, counts, onlyIn{Supabase,Turso}, mismatches[], ... }
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SB_URL =
  process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return !!given && given === secret;
}

function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(",")}}`;
}

async function supabaseListKeys(prefix: string): Promise<string[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/flipify_kv?device_id=eq.whopclip` +
        `&key=like.${encodeURIComponent(prefix)}*` +
        `&select=key&order=key&limit=10000`,
      {
        cache: "no-store",
        signal: ctrl.signal,
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      }
    );
    if (!res.ok) throw new Error(`supabase list ${res.status}`);
    const rows = (await res.json()) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { supabaseKV, kvReadSource, kvWriteMode } = await import("@/lib/db");
  const { tursoKV, tursoEnabled, tursoListKeys, tursoHealth } = await import(
    "@/lib/turso"
  );
  const { kvBackendName } = await import("@/lib/store");

  const q = req.nextUrl.searchParams;
  const prefix = q.get("prefix") ?? "whopclip:";
  const concurrency = Math.min(
    Math.max(parseInt(q.get("concurrency") ?? "25", 10) || 25, 1),
    50
  );

  const health = tursoEnabled ? await tursoHealth() : { ok: false, latencyMs: -1 };
  if (!tursoEnabled) {
    return NextResponse.json({
      ok: false,
      error: "turso not configured (TURSO_AUTH_TOKEN missing)",
      readSource: kvReadSource(),
      writeMode: kvWriteMode(),
      backend: kvBackendName(),
    });
  }

  let sbKeys: string[];
  try {
    sbKeys = await supabaseListKeys(prefix);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `supabase list failed: ${e instanceof Error ? e.message : e}` },
      { status: 502 }
    );
  }
  let tKeys: string[];
  try {
    tKeys = (await tursoListKeys()).filter((k) => k.startsWith(prefix));
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `turso list failed: ${e instanceof Error ? e.message : e}` },
      { status: 502 }
    );
  }

  const sbSet = new Set(sbKeys);
  const tSet = new Set(tKeys);
  const onlyInSupabase = sbKeys.filter((k) => !tSet.has(k));
  const onlyInTurso = tKeys.filter((k) => !sbSet.has(k));
  const common = sbKeys.filter((k) => tSet.has(k));

  const strip = (k: string) => k.replace(/^whopclip:/, "");
  const mismatches: string[] = [];
  let compared = 0;
  for (let i = 0; i < common.length; i += concurrency) {
    const batch = common.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (k) => {
        const sk = strip(k);
        const [a, b] = await Promise.all([
          supabaseKV.get(sk).catch(() => "__ERR__"),
          tursoKV.get(sk).catch(() => "__ERR__"),
        ]);
        return { k, same: canon(a) === canon(b) };
      })
    );
    for (const r of results) {
      compared++;
      if (!r.same && mismatches.length < 50) mismatches.push(r.k);
    }
  }

  const ok =
    health.ok &&
    onlyInSupabase.length === 0 &&
    onlyInTurso.length === 0 &&
    mismatches.length === 0;
  return NextResponse.json({
    ok,
    readSource: kvReadSource(),
    writeMode: kvWriteMode(),
    backend: kvBackendName(),
    tursoHealth: health,
    supabaseKeys: sbKeys.length,
    tursoKeys: tKeys.length,
    compared,
    onlyInSupabase,
    onlyInTurso,
    mismatches,
  });
}
