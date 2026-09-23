import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { applyToCampaign, probeJoinState, WhopError } from "@/lib/whop";
import { getCampaign, upsertCampaign, logActivity } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/whop/apply
 * Owner-auth. Server-side campaign join: uses the user's saved Whop session
 * (uploaded by the phone, user-approved) to POST the apply call from Vercel's
 * servers. Fail-closed: probes join state first; already-joined -> no-op.
 * Body: { device_id, campaign_id }
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const campaign_id = typeof body?.campaign_id === "string" ? body.campaign_id : "";
    if (!device_id || !campaign_id) {
      return NextResponse.json({ error: "device_id and campaign_id required" }, { status: 400 });
    }
    const campaign = await getCampaign(campaign_id);
    if (!campaign) {
      return NextResponse.json({ error: "campaign not in store — discover/check first" }, { status: 404 });
    }
    // Fail-closed: don't double-join.
    const probe = await probeJoinState(device_id, campaign_id);
    if (probe.joined === true || campaign.joined) {
      await upsertCampaign({ ...campaign, joined: true, updated_at: new Date().toISOString() });
      await logActivity(device_id, "server_apply", `Apply skipped: ${campaign.name} already joined (${probe.detail})`);
      return NextResponse.json({ ok: true, already_joined: true, detail: probe.detail });
    }
    const r = await applyToCampaign(device_id, campaign_id, {});
    if (!r.ok) {
      await logActivity(device_id, "server_apply", `Apply FAILED: ${campaign.name} — ${r.error}`);
      return NextResponse.json({ error: r.error, detail: r.data }, { status: r.status || 502 });
    }
    await upsertCampaign({ ...campaign, joined: true, updated_at: new Date().toISOString() });
    await logActivity(device_id, "server_apply", `Server apply: ${campaign.name} joined (server-side, USA)`);
    return NextResponse.json({ ok: true, joined: true, response: r.data });
  } catch (e) {
    const err = e as Error;
    const status = e instanceof WhopError ? e.status : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
