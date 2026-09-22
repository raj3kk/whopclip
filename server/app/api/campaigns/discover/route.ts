import { NextRequest, NextResponse } from "next/server";
import { listCampaigns, upsertCampaign, type Campaign } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * POST /api/campaigns/discover { device_id, campaigns_json }
 * Ingests campaign cards scraped by the phone's discoverCampaignsJob.
 * Owner-auth required. New campaigns are upserted with requirements=null and
 * needs_requirements=true so the check step extracts + parses the brief
 * before anything renders.
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const raw = body?.campaigns_json;
    if (typeof raw !== "string" || !raw.length) {
      return NextResponse.json({ error: "campaigns_json required" }, { status: 400 });
    }
    let cards: Array<{ name?: string; url?: string; text?: string }>;
    try {
      cards = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "campaigns_json is not valid JSON" }, { status: 400 });
    }
    const existing = new Map((await listCampaigns()).map((c) => [c.whop_url, c]));
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    for (const card of cards.slice(0, 40)) {
      const url = typeof card.url === "string" ? card.url.trim() : "";
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const name =
        (typeof card.name === "string" && card.name.trim()) || "Untitled campaign";
      // payout hint from card text: "$4 per 1k"
      let payout = 0;
      const pm = (card.text ?? "").match(/\$\s*(\d+(?:\.\d+)?)\s*(?:per|\/)\s*1\s*k/i);
      if (pm) payout = parseFloat(pm[1]);
      const prev = existing.get(url);
      const campaign: Campaign = {
        id: prev?.id ?? url,
        name: prev?.name ?? name,
        whop_url: url,
        active: prev?.active ?? true,
        budget_remaining: prev?.budget_remaining ?? 0,
        payout_per_1k: prev?.payout_per_1k ?? payout,
        joined: prev?.joined ?? false,
        requirements: prev?.requirements ?? null,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      };
      await upsertCampaign(campaign);
      if (prev) updated++;
      else added++;
    }
    return NextResponse.json({ ok: true, added, updated });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
