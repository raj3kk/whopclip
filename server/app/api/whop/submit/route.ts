import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { createSubmission, WhopError } from "@/lib/whop";
import { getCampaign, logActivity, recordSubmission, alreadySubmitted } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/whop/submit
 * Owner-auth. Server-side submission: posts the clip entry to Whop from
 * Vercel's servers using the user's saved session. Fail-closed: refuses
 * duplicates (alreadySubmitted) and unknown campaigns.
 * Body: { device_id, campaign_id, platform, post_url }
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const campaign_id = typeof body?.campaign_id === "string" ? body.campaign_id : "";
    const platform = typeof body?.platform === "string" ? body.platform : "instagram";
    const post_url = typeof body?.post_url === "string" ? body.post_url : "";
    if (!device_id || !campaign_id || !post_url) {
      return NextResponse.json(
        { error: "device_id, campaign_id and post_url required" },
        { status: 400 }
      );
    }
    if (!/^https?:\/\//i.test(post_url)) {
      return NextResponse.json({ error: "post_url must be a valid URL" }, { status: 400 });
    }
    const campaign = await getCampaign(campaign_id);
    if (!campaign) {
      return NextResponse.json({ error: "campaign not in store" }, { status: 404 });
    }
    if (await alreadySubmitted(device_id, campaign_id)) {
      return NextResponse.json({ ok: true, already_submitted: true });
    }
    const r = await createSubmission(device_id, {
      campaignId: campaign_id,
      platform,
      url: post_url,
    });
    if (!r.ok) {
      await logActivity(device_id, "server_submit", `Submit FAILED: ${campaign.name} — ${r.error}`);
      return NextResponse.json(
        { error: r.error, detail: r.data, hint: "API ne body reject ki — shape check karo" },
        { status: r.status || 502 }
      );
    }
    const now = new Date().toISOString();
    await recordSubmission({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      device_id,
      campaign_id,
      campaign_name: campaign.name,
      ig_post_url: post_url,
      status: "submitted",
      payout_per_1k: campaign.payout_per_1k,
      views: null,
      earned_usd: null,
      created_at: now,
    });
    await logActivity(device_id, "server_submit", `Server submit: ${campaign.name} — ${post_url} (server-side, USA)`);
    return NextResponse.json({ ok: true, submitted: true, response: r.data });
  } catch (e) {
    const err = e as Error;
    const status = e instanceof WhopError ? e.status : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
