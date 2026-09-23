import { NextRequest, NextResponse } from "next/server";
import { getCampaign } from "@/lib/store";
import {
  activeChain,
  listActiveChains,
  listChains,
  startChain,
  type Chain,
} from "@/lib/chain";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET  /api/chains?device_id=&campaign_id=  -> chains for a campaign
 * POST /api/chains { device_id, campaign_id } (owner login)
 *   -> start a full auto-chain: check->join->render->post->verify->submit->done
 *
 * The chain advances itself off job completions (POST /api/jobs/:id) and
 * render results (POST /api/render/result). The dashboard only starts it
 * and watches it.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  const campaign_id = req.nextUrl.searchParams.get("campaign_id") ?? "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  // device-level: all active chains (dashboard Chains tab).
  // device+campaign: full history for that campaign.
  const chains = campaign_id
    ? await listChains(device_id, campaign_id)
    : await listActiveChains(device_id);
  return NextResponse.json({ chains });
}

export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const campaign_id =
      typeof body?.campaign_id === "string" ? body.campaign_id : "";
    if (!device_id || !campaign_id) {
      return NextResponse.json(
        { error: "device_id and campaign_id required" },
        { status: 400 }
      );
    }
    const campaign = await getCampaign(campaign_id);
    if (!campaign) {
      return NextResponse.json({ error: "campaign not found" }, { status: 404 });
    }
    const chain: Chain = await startChain(device_id, campaign);
    return NextResponse.json({ ok: true, chain });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    const status = /already (active|submitted)/i.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
