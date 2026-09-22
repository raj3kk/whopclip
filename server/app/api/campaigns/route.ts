import { NextRequest, NextResponse } from "next/server";
import {
  getSession,
  listCampaigns,
  parseRequirements,
  selectCampaign,
  upsertCampaign,
  type Campaign,
} from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET  /api/campaigns?device_id=... -> campaign list for this device
 * POST /api/campaigns { action:"select", device_id } -> best eligible campaign
 *   (active + budget>0 + not already submitted; prefers joined, then payout)
 * POST /api/campaigns { action:"upsert", campaign } -> add/update campaign record
 */
export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  if (!(await getSession(device_id, "whop"))) {
    return NextResponse.json({ error: "whop not linked" }, { status: 409 });
  }
  return NextResponse.json({ device_id, campaigns: await listCampaigns() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body?.action === "select") {
      const { device_id } = body;
      if (!device_id) {
        return NextResponse.json({ error: "device_id required" }, { status: 400 });
      }
      const campaign = await selectCampaign(device_id);
      if (!campaign) {
        return NextResponse.json(
          { campaign: null, reason: "no eligible campaign (inactive / no budget / already submitted)" }
        );
      }
      return NextResponse.json({ campaign });
    }
    if (body?.action === "upsert") {
      // Owner write operation: campaign create/update requires owner login.
      if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
        return NextResponse.json({ error: "login required" }, { status: 401 });
      }
      const c = body.campaign as Partial<Campaign>;
      if (!c?.id || !c?.name || !c?.whop_url) {
        return NextResponse.json(
          { error: "campaign.id, campaign.name, campaign.whop_url required" },
          { status: 400 }
        );
      }
      const now = new Date().toISOString();
      const existing = (await listCampaigns()).find((x) => x.id === c.id);
      await upsertCampaign({
        id: c.id,
        name: c.name,
        whop_url: c.whop_url,
        active: c.active !== false,
        budget_remaining: typeof c.budget_remaining === "number" ? c.budget_remaining : 0,
        payout_per_1k: typeof c.payout_per_1k === "number" ? c.payout_per_1k : 0,
        joined: c.joined === true,
        requirements: c.requirements ? parseRequirements(c.requirements) : null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
      return NextResponse.json({ ok: true, id: c.id });
    }
    return NextResponse.json({ error: "action must be select|upsert" }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
