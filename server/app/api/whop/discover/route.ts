import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import {
  discoverCampaigns,
  cardToCampaign,
  WhopError,
} from "@/lib/whop";
import { listCampaigns, upsertCampaign, logActivity } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/whop/discover
 * Owner-auth. Runs campaign discovery ON THE SERVER (Vercel, USA) instead of
 * the phone's WebView: GET contentrewards.com/discover, parse the SSR-embedded
 * campaign cards, upsert into the campaign store.
 * Body: { device_id } (for activity logging).
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const cards = await discoverCampaigns();
    const existing = new Map((await listCampaigns()).map((c) => [c.id, c]));
    let added = 0;
    let updated = 0;
    for (const card of cards) {
      const prev = existing.get(card.id) ?? null;
      await upsertCampaign(cardToCampaign(card, prev));
      if (prev) updated++;
      else added++;
    }
    const ms = Date.now() - t0;
    if (device_id) {
      await logActivity(
        device_id,
        "server_discover",
        `Server discover: ${cards.length} campaigns (${added} naye, ${updated} updated) — ${ms}ms, phone WebView use nahi hua`
      );
    }
    return NextResponse.json({
      ok: true,
      count: cards.length,
      added,
      updated,
      ms,
      campaigns: cards.map((c) => ({
        id: c.id,
        name: c.title || c.brand,
        budget_remaining: c.availableBudget,
        rate: c.ratePer1kLabel,
        platforms: c.platforms,
      })),
    });
  } catch (e) {
    const err = e as Error;
    const status = e instanceof WhopError ? e.status : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
