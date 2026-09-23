import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { runAutoDiscover, getAutoDiscoverLog } from "@/lib/automation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/automation/discover — the automated campaign pipeline entry.
 * Body: { device_id, query?, dry_run?, max_pages? }
 *
 * Runs the server-side equivalent of the user's in-app flow:
 *   search "instagram" -> scroll (paginate) -> score every campaign with a
 *   logged rationale -> apply exclusion gates (already submitted, $0 budget,
 *   dead campaigns, requiresApplication, no IG payout, paused/private)
 *   -> top pick.
 *
 * dry_run=true (default): returns the ranked table + picked campaign +
 * extracted requirements summary. No chain is started, nothing is joined.
 * dry_run=false: ALSO starts one chain on the top pick via startChain
 * (which enforces all its own fail-closed gates: daily cap, no dupes).
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    if (!device_id) {
      return NextResponse.json({ error: "device_id required" }, { status: 400 });
    }
    const result = await runAutoDiscover(device_id, {
      query: typeof body?.query === "string" ? body.query : undefined,
      dryRun: body?.dry_run !== false,
      maxPages:
        typeof body?.max_pages === "number"
          ? Math.min(Math.max(body.max_pages, 1), 5)
          : undefined,
    });
    // ScoredPick carries the full SearchHit (assets, guidelines) — trim it
    // for the response; the full brief summary is returned separately.
    const slim = {
      ...result,
      picked: result.picked
        ? {
            score: Math.round(result.picked.score * 1000) / 1000,
            excluded: result.picked.excluded,
            excludeReason: result.picked.excludeReason,
            rationale: result.picked.rationale,
            name: result.picked.hit.name,
            id: result.picked.hit.id,
          }
        : null,
    };
    return NextResponse.json({ ok: true, ...slim });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}

/** GET /api/automation/discover?device_id= — last auto-discover run (dashboard). */
export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const log = await getAutoDiscoverLog(device_id);
  return NextResponse.json({ ok: true, log });
}
