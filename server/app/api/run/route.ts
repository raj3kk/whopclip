import { NextRequest, NextResponse } from "next/server";
import { enqueueRunStep, RunError } from "@/lib/run";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * POST /api/run (owner login)
 * Body: { device_id, step: "full"|"discover"|"check"|"join"|"render"|"post"|"verify"|"submit",
 *         campaign_id?, caption?, video_url?, ig_post_url?, discover_url?, brief_text? }
 *
 * Enqueues real JobEngine step templates for the phone (see lib/run.ts).
 * "render" is server-side: it parses brief_text and enqueues a VM render spec.
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const step = typeof body?.step === "string" ? body.step : "check";
    const { job, campaign, chain, server_result } = await enqueueRunStep(device_id, step, {
      campaign_id: body?.campaign_id,
      caption: body?.caption,
      video_url: body?.video_url,
      ig_post_url: body?.ig_post_url,
      discover_url: body?.discover_url,
      brief_text: body?.brief_text,
    });
    return NextResponse.json({
      ok: true,
      job_id: job.id,
      type: job.type,
      chain_id: chain?.id ?? null,
      campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
      discovering: !campaign && job.type === "server_discover",
      server_side: server_result != null,
      server_result: server_result ?? null,
    });
  } catch (e: unknown) {
    if (e instanceof RunError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
