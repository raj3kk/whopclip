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
  getJob,
  selectCampaign,
  type Campaign,
  type Job,
} from "./store";
import { extractRequirementsFromText } from "./requirements";
import { buildRenderSpec, enqueueRender, getRender } from "./render";
import {
  checkJoinJob,
  discoverCampaignsJob,
  joinJob,
  igPostJob,
  verifyReelJob,
  whopSubmitJob,
} from "./jobs";

export interface RunStepOptions {
  campaign_id?: string;
  caption?: string;
  video_url?: string;
  ig_post_url?: string;
  discover_url?: string;
  /** requirements_text from a completed check job (for the render step) */
  brief_text?: string;
}

export class RunError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Enqueue a real JobEngine step template for the phone (or the VM worker):
 *  - discover -> whop_discover (scrapes campaign cards; needs discover_url)
 *  - check    -> whop_check_join (reads join state + requirements)
 *  - join     -> whop_join (only if not joined)
 *  - render   -> VM worker renders the 9:16 clip (server-side, not the phone).
 *                Needs a completed check job's requirements_text: pass
 *                check_job_id, or pre-parsed requirements via campaign.
 *  - post     -> ig_post (needs caption + video_url; payload.video_url is read by the phone)
 *  - verify   -> ig_verify (needs ig_post_url; DOM-level live check)
 *  - submit   -> whop_submit (needs campaign_id + ig_post_url)
 *  - full     -> check now; dashboard chains the rest off job results
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
    case "discover": {
      const discoverUrl =
        typeof opts.discover_url === "string" ? opts.discover_url : "";
      if (!discoverUrl || !/^https?:\/\//i.test(discoverUrl)) {
        throw new RunError(400, "discover_url required for discover step");
      }
      job = mkJob("whop_discover", discoverCampaignsJob(discoverUrl), {
        campaign_id: campaign.id,
      });
      break;
    }
    case "check":
      job = mkJob("whop_check_join", checkJoinJob(campaign));
      break;
    case "join":
      if (campaign.joined) {
        throw new RunError(409, "campaign already joined");
      }
      job = mkJob("whop_join", joinJob(campaign));
      break;
    case "render": {
      // Server-side: parse the brief text (from a completed check job's
      // requirements_text) and enqueue a render spec for the VM worker.
      // FAIL-CLOSED on incomplete requirements.
      const text =
        typeof opts.brief_text === "string" ? opts.brief_text : "";
      if (text.length < 50) {
        throw new RunError(
          400,
          "render needs brief_text (requirements_text from a completed check job)"
        );
      }
      const extraction = extractRequirementsFromText(text);
      if (!extraction.complete) {
        throw new RunError(
          422,
          `render blocked: incomplete requirements (${extraction.missing.join("; ")})`
        );
      }
      const spec = buildRenderSpec(device_id, campaign, extraction.requirements, {
        authorized_sources: extraction.authorized_sources,
        title_templates: extraction.title_templates,
      });
      await enqueueRender(spec);
      // Return a marker job so the dashboard can track render state.
      job = mkJob("render_clip", [], {
        payload: { render_id: spec.id },
        campaign_id: campaign.id,
      });
      // render_clip jobs are server-side; mark done immediately — the VM
      // worker picks up the spec via /api/render/next.
      job.status = "done";
      job.result = { render_id: spec.id, status: "queued" };
      break;
    }
    case "verify": {
      const ig_post_url =
        typeof opts.ig_post_url === "string" ? opts.ig_post_url : "";
      if (!ig_post_url || !/^https?:\/\//i.test(ig_post_url)) {
        throw new RunError(400, "ig_post_url required for verify step");
      }
      job = mkJob(
        "ig_verify",
        verifyReelJob(ig_post_url),
        { payload: { ig_post_url }, campaign_id: campaign.id }
      );
      break;
    }
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
