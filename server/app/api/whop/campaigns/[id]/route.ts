import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import {
  getCampaignDetail,
  detailToCampaign,
  probeJoinState,
  WhopError,
} from "@/lib/whop";
import { getCampaign, upsertCampaign, logActivity } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/whop/campaigns/[id]?device_id=...
 * Owner-auth. Server-side campaign check: fetches the campaign page on the
 * server (Vercel USA), parses the embedded brief/payouts/requirements, and
 * probes the join state with the user's saved Whop session. Upserts the
 * campaign record. This replaces the phone's whop_check_join WebView job.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  try {
    const detail = await getCampaignDetail(params.id);
    const prev = await getCampaign(params.id);
    let joined = prev?.joined ?? false;
    let joinDetail = "join state not probed (no device_id)";
    if (device_id) {
      try {
        const probe = await probeJoinState(device_id, params.id);
        joinDetail = probe.detail;
        if (probe.joined !== null) joined = probe.joined;
      } catch (e) {
        joinDetail = `probe failed: ${e instanceof Error ? e.message : "unknown"}`;
      }
    }
    const campaign = detailToCampaign(detail, prev);
    campaign.joined = joined;
    await upsertCampaign(campaign);
    if (device_id) {
      await logActivity(
        device_id,
        "server_check",
        `Server check: ${detail.name} — budget $${detail.budgetRemaining.toFixed(0)}, joined=${joined} (${joinDetail})`
      );
    }
    return NextResponse.json({
      ok: true,
      campaign: {
        id: detail.id,
        name: detail.name,
        brand: detail.brand,
        status: detail.status,
        budget_remaining: detail.budgetRemaining,
        payouts: detail.payouts,
        platforms: detail.platforms,
        content_requirements: detail.contentRequirements,
        reference_materials: detail.referenceMaterials,
        requires_application: detail.requiresApplication,
        joined,
        join_detail: joinDetail,
        requirements: campaign.requirements,
      },
    });
  } catch (e) {
    const err = e as Error;
    const status = e instanceof WhopError ? e.status : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
