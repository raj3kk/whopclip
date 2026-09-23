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
  listCampaigns,
  selectCampaign,
  upsertCampaign,
  type Campaign,
  type Job,
} from "./store";
import { extractRequirementsFromText } from "./requirements";
import { buildRenderSpec, enqueueRender, getRender } from "./render";
import {
  checkJoinJob,
  joinJob,
  igPostJob,
  whopSubmitJob,
} from "./jobs";
import { startChain, type Chain } from "./chain";
import {
  discoverCampaigns,
  cardToCampaign,
} from "./whop";
import { verifyReel } from "./instagram";
import { logActivity } from "./store";

/** Default Whop Content Rewards discovery page (overridable per run). */
export const DEFAULT_DISCOVER_URL = "https://whop.com/content-rewards";

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
 *  - discover -> SERVER-SIDE: fetches contentrewards.com/discover on Vercel
 *                (USA), parses SSR-embedded cards, upserts campaigns. No
 *                phone job, no discover_url needed.
 *  - check    -> whop_check_join (reads join state + requirements)
 *  - join     -> whop_join (only if not joined)
 *  - render   -> VM worker renders the 9:16 clip (server-side, not the phone).
 *                Needs a completed check job's requirements_text: pass
 *                check_job_id, or pre-parsed requirements via campaign.
 *  - post     -> ig_post (needs caption + video_url; payload.video_url is read by the phone)
 *  - verify   -> ig_verify (needs ig_post_url; DOM-level live check)
 *  - submit   -> whop_submit (needs campaign_id + ig_post_url)
 *  - full     -> startChain(): check now, server auto-advances the rest
 *                off job completions (chain engine).
 *
 * When no eligible campaign exists and no campaign_id was given, a
 * server-side discover runs automatically instead of failing — the pipeline
 * refills its own campaign list. Returns campaign=null in that case.
 */
export async function enqueueRunStep(
  device_id: string,
  step: string,
  opts: RunStepOptions = {}
): Promise<{
  job: Job;
  campaign: Campaign | null;
  chain?: Chain;
  /** present when the step ran on the server instead of the phone */
  server_result?: unknown;
}> {
  if (!device_id) throw new RunError(400, "device_id required");

  let campaign: Campaign | null = null;
  if (opts.campaign_id) {
    campaign = await getCampaign(String(opts.campaign_id));
    if (!campaign) throw new RunError(404, "campaign not found");
  } else {
    campaign = await selectCampaign(device_id);
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

  // ---- Server-side discover helper ----
  // Discovery now runs on Vercel (USA), not the phone's WebView: the rewards
  // site SSR-embeds all campaign cards, so a plain server GET is faster,
  // deterministic, and region-proof. Results go straight into the store.
  const serverDiscover = async (): Promise<{
    job: Job;
    campaign: null;
    server_result: unknown;
  }> => {
    const t0 = Date.now();
    const cards = await discoverCampaigns();
    const existing = new Map((await listCampaigns()).map((c) => [c.id, c]));
    let added = 0;
    for (const card of cards) {
      const prev = existing.get(card.id) ?? null;
      await upsertCampaign(cardToCampaign(card, prev));
      if (!prev) added++;
    }
    const ms = Date.now() - t0;
    const result = {
      count: cards.length,
      added,
      ms,
      campaigns: cards.map((c) => ({
        id: c.id,
        name: c.title || c.brand,
        budget_remaining: c.availableBudget,
        rate: c.ratePer1kLabel,
      })),
    };
    await logActivity(
      device_id,
      "server_discover",
      `Server discover: ${cards.length} campaigns (${added} naye) — ${ms}ms, server-side (USA)`
    );
    const job: Job = {
      id: `server-${crypto.randomUUID()}`,
      device_id,
      type: "server_discover",
      status: "done",
      steps: [{ action: "server_discover" }],
      campaign_id: undefined,
      result,
      created_at: now,
      updated_at: new Date().toISOString(),
    };
    return { job, campaign: null, server_result: result };
  };

  // No eligible campaign: auto-discover server-side instead of 409. The
  // server fetches the rewards page directly; the next tick then has
  // campaigns to chain.
  if (!campaign && !opts.campaign_id) {
    return serverDiscover();
  }
  if (!campaign) {
    throw new RunError(
      409,
      "no eligible campaign (inactive / no budget / already submitted)"
    );
  }

  let job: Job;
  switch (step) {
    case "discover": {
      // Server-side discover (Vercel USA) — no phone job, no discover_url
      // needed. The rewards site embeds campaign cards in the SSR payload.
      return serverDiscover();
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
      // Server-side verify (Vercel): fetch the reel with the user's saved IG
      // session — live check, caption tags, 9:16, duration. Deterministic,
      // no phone WebView needed. Fail-closed: not live -> RunError.
      const required_tags = [
        ...(campaign.requirements?.required_mentions ?? []),
        ...(campaign.requirements?.required_hashtags ?? []),
      ];
      const vr = await verifyReel(device_id, ig_post_url, { required_tags });
      await logActivity(
        device_id,
        "server_verify",
        `Server verify: ${ig_post_url} — live=${vr.live} (${vr.checks
          .map((c) => `${c.name}:${c.ok ? "ok" : "FAIL"}`)
          .join(", ")})`
      );
      if (!vr.live) {
        throw new RunError(
          422,
          `reel verify failed: ${vr.checks
            .filter((c) => !c.ok)
            .map((c) => `${c.name} (${c.detail})`)
            .join("; ")}`
        );
      }
      const vjob: Job = {
        id: `server-${crypto.randomUUID()}`,
        device_id,
        type: "server_verify",
        status: "done",
        steps: [{ action: "server_verify" }],
        payload: { ig_post_url },
        campaign_id: campaign.id,
        result: {
          verify_result: {
            live: vr.live,
            shortcode: vr.shortcode,
            caption: vr.caption,
            duration_s: vr.duration_s,
            width: vr.width,
            height: vr.height,
            like_count: vr.like_count,
            checks: vr.checks,
          },
        },
        created_at: now,
        updated_at: new Date().toISOString(),
      };
      return { job: vjob, campaign, server_result: vjob.result };
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
    default: {
      // full = startChain(): enqueues the check job AND registers the chain,
      // so job completions auto-advance check->join->render->post->verify->submit.
      // startChain throws on already-active/already-submitted (fail-closed).
      const chain = await startChain(device_id, campaign);
      const checkJob = await getJob(chain.job_id ?? "");
      if (!checkJob) throw new RunError(500, "chain started but check job missing");
      return { job: checkJob, campaign, chain };
    }
  }

  await enqueueJob(job);
  return { job, campaign };
}
