import { NextRequest, NextResponse } from "next/server";
import { enqueueRunStep, RunError } from "@/lib/run";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * POST /api/run (owner login)
 * Body: { device_id, step: "full"|"check"|"join"|"post"|"submit",
 *         campaign_id?, caption?, video_url?, ig_post_url? }
 *
 * Enqueues real JobEngine step templates for the phone (see lib/run.ts).
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const step = typeof body?.step === "string" ? body.step : "check";
    const { job, campaign } = await enqueueRunStep(device_id, step, {
      campaign_id: body?.campaign_id,
      caption: body?.caption,
      video_url: body?.video_url,
      ig_post_url: body?.ig_post_url,
    });
    return NextResponse.json({
      ok: true,
      job_id: job.id,
      type: job.type,
      campaign: { id: campaign.id, name: campaign.name },
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
