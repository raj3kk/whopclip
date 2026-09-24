import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/internal/kv-export — TEMPORARY (added 2026-09-24 for the
 * Supabase -> Turso Phase 0 migration). Dumps `whopclip:*` rows from
 * `flipify_kv` with keyset pagination. Auth: x-cron-secret (same
 * CRON_SECRET as the render worker). REMOVE after the migration export
 * is pulled; it exists only because the VM has no service_role key.
 *
 * Query: ?limit=200&cursor=<last_key> -> { rows, next_cursor }
 */
export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!SB_KEY) {
    return NextResponse.json({ error: "db not configured" }, { status: 500 });
  }
  const q = req.nextUrl.searchParams;
  const limit = Math.min(
    Math.max(parseInt(q.get("limit") ?? "200", 10) || 200, 1),
    1000
  );
  const cursor = q.get("cursor") ?? "";
  let path =
    `/rest/v1/flipify_kv?device_id=eq.whopclip&key=like.whopclip:*` +
    `&select=key,value,updated_at&order=key&limit=${limit}`;
  if (cursor) path += `&key=gt.${encodeURIComponent(cursor)}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      cache: "no-store",
      signal: ctrl.signal,
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
      },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `supabase ${res.status}` },
        { status: 502 }
      );
    }
    const rows = (await res.json()) as Array<{
      key: string;
      value: unknown;
      updated_at: string;
    }>;
    const next_cursor =
      rows.length === limit ? rows[rows.length - 1].key : null;
    return NextResponse.json({ rows, next_cursor });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 502 }
    );
  } finally {
    clearTimeout(t);
  }
}
