/**
 * WhopClip run orchestration — shared by POST /api/run (owner dashboard)
 * and GET /api/schedule/tick (server cron).
 *
 * Call enqueueRunStep() directly when you are already server-side (no HTTP
 * auth needed); the API route adds the owner-cookie gate on top.
 */
import crypto from "crypto";
import {
  enqueueJob,
  getCampaign,
  selectCampaign,
  type Campaign,
  type Job,
} from "./store";
import { checkJoinJob, joinJob, igPostJob, whopSubmitJob } from "./jobs";

export interface RunStepOptions {
  campaign_id?: string;
  caption?: string;
  video_url?: string;
  ig_post_url?: string;
}

export class RunError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Enqueue a real JobEngine step template for the phone:
 *  - check  -> whop_check_join (reads join state + requirements)
 *  - join   -> whop_join (only if not joined)
 *  - post   -> ig_post (needs caption + video_url; payload.video_url is read by the phone)
 *  - submit -> whop_submit (needs campaign_id + ig_post_url)
 *  - full   -> check now; dashboard chains the rest off job results
 */
export async function enqueueRunStep(
  device_id: string,
  step: string,
  opts: RunStepOptions = {}
): Promise<{ job: Job; campaign: Campaign }> {
  if (!device_id) throw new RunError(400, "device_id required");

  let campaign: Campaign | null = null;
  if (opts.campaign_id) {
    campaign = await getCampaign(String(opts.campaign_id));
    if (!campaign) throw new RunError(404, "campaign not found");
  } else {
    campaign = await selectCampaign(device_id);
    if (!campaign) {
      throw new RunError(
        409,
        "no eligible campaign (inactive / no budget / already submitted)"
      );
    }
  }

  const now = new Date().toISOString();
  const mkJob = (
    type: string,
    steps: Record<string, unknown>[],
    extra: Partial<Job> = {}
  ): Job => ({
    id: crypto.randomUUID(),
    device_id,
    type,
    status: "queued",
    steps,
    payload: extra.payload,
    campaign_id: extra.campaign_id,
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
        throw new RunError(409, "campaign already joined");
      }
      job = mkJob("whop_join", joinJob(campaign));
      break;
    case "post": {
      const caption = typeof opts.caption === "string" ? opts.caption : "";
      const video_url = typeof opts.video_url === "string" ? opts.video_url : "";
      if (!caption || !video_url) {
        throw new RunError(400, "caption and video_url required for post step");
      }
      job = mkJob(
        "ig_post",
        igPostJob({ caption, video_hint: video_url }),
        { payload: { video_url }, campaign_id: campaign.id }
      );
      break;
    }
    case "submit": {
      const ig_post_url =
        typeof opts.ig_post_url === "string" ? opts.ig_post_url : "";
      if (!ig_post_url) {
        throw new RunError(400, "ig_post_url required for submit step");
      }
      job = mkJob(
        "whop_submit",
        whopSubmitJob({ campaign_url: campaign.whop_url, ig_post_url }),
        { payload: { ig_post_url }, campaign_id: campaign.id }
      );
      break;
    }
    case "full":
    default:
      // full = start with the check; dashboard chains the rest off job results
      job = mkJob("whop_check_join", checkJoinJob(campaign));
      break;
  }

  await enqueueJob(job);
  return { job, campaign };
}
