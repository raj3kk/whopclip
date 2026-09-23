import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { verifyReel, IgError } from "@/lib/instagram";
import { getCampaign, logActivity } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ig/verify
 * Owner-auth. Server-side Instagram reel verification: fetches the reel with
 * the user's saved IG session and checks live/playable/duration/9:16/caption
 * tags. Fail-closed: any failed check -> live=false with reasons.
 * Body: { device_id, post_url, campaign_id? }
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const post_url = typeof body?.post_url === "string" ? body.post_url : "";
    const campaign_id = typeof body?.campaign_id === "string" ? body.campaign_id : "";
    if (!device_id || !post_url) {
      return NextResponse.json({ error: "device_id and post_url required" }, { status: 400 });
    }
    let required_tags: string[] = [];
    if (campaign_id) {
      const c = await getCampaign(campaign_id);
      if (c?.requirements) {
        required_tags = [
          ...(c.requirements.required_mentions ?? []),
          ...(c.requirements.required_hashtags ?? []),
        ];
      }
    }
    const vr = await verifyReel(device_id, post_url, { required_tags });
    await logActivity(
      device_id,
      "server_verify",
      `Server verify: ${post_url} — live=${vr.live}`
    );
    return NextResponse.json({ ok: true, ...vr });
  } catch (e) {
    const err = e as Error;
    const status = e instanceof IgError ? e.status : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
