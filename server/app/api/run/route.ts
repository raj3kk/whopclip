import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  enqueueJob,
  getCampaign,
  selectCampaign,
  type Job,
  type Campaign,
} from "@/lib/store";
import { checkJoinJob, joinJob, igPostJob, whopSubmitJob } from "@/lib/jobs";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * POST /api/run (owner login)
 * Body: { device_id, step: "full"|"check"|"join"|"post"|"submit",
 *         campaign_id?, caption?, video_url? }
 *
 * Enqueues real JobEngine step templates for the phone:
 *  - check  -> whop_check_join (reads join state + requirements)
 *  - join   -> whop_join (only if not joined)
 *  - post   -> ig_post (needs caption + video_url)
 *  - submit -> whop_submit (needs campaign_id + ig_post_url from a post job result)
 *  - full   -> check now; dashboard guides join/post/submit after each result
 */
export async function POST(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const device_id = typeof body?.device_id === "string" ? body.device_id : "";
    const step = typeof body?.step === "string" ? body.step : "check";
    if (!device_id) {
      return NextResponse.json({ error: "device_id required" }, { status: 400 });
    }

    let campaign: Campaign | null = null;
    if (body?.campaign_id) {
      campaign = await getCampaign(String(body.campaign_id));
      if (!campaign) {
        return NextResponse.json({ error: "campaign not found" }, { status: 404 });
      }
    } else {
      campaign = await selectCampaign(device_id);
      if (!campaign) {
        return NextResponse.json(
          { error: "no eligible campaign (inactive / no budget / already submitted)" },
          { status: 409 }
        );
      }
    }

    const now = new Date().toISOString();
    const mkJob = (type: string, steps: Record<string, unknown>[]): Job => ({
      id: crypto.randomUUID(),
      device_id,
      type,
      status: "queued",
      steps,
      result: null,
      created_at: now,
      updated_at: now,
    });

    let job: Job;
    switch (step) {
      case "check":
        job = mkJob("whop_check_join", checkJoinJob(campaign));
        break;
      case "join":
        if (campaign.joined) {
          return NextResponse.json({ error: "campaign already joined" }, { status: 409 });
        }
        job = mkJob("whop_join", joinJob(campaign));
        break;
      case "post": {
        const caption = typeof body?.caption === "string" ? body.caption : "";
        const video_url = typeof body?.video_url === "string" ? body.video_url : "";
        if (!caption || !video_url) {
          return NextResponse.json(
            { error: "caption and video_url required for post step" },
            { status: 400 }
          );
        }
        job = mkJob("ig_post", igPostJob({ caption, video_hint: video_url }));
        (job as unknown as Record<string, unknown>).campaign_id = campaign.id;
        break;
      }
      case "submit": {
        const ig_post_url = typeof body?.ig_post_url === "string" ? body.ig_post_url : "";
        if (!ig_post_url) {
          return NextResponse.json(
            { error: "ig_post_url required for submit step" },
            { status: 400 }
          );
        }
        job = mkJob("whop_submit", whopSubmitJob({ campaign_url: campaign.whop_url, ig_post_url }));
        break;
      }
      case "full":
      default:
        // full = start with the check; dashboard chains the rest off job results
        job = mkJob("whop_check_join", checkJoinJob(campaign));
        break;
    }

    await enqueueJob(job);
    return NextResponse.json({ ok: true, job_id: job.id, type: job.type, campaign: { id: campaign.id, name: campaign.name } });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
