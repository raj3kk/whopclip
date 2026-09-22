/**
 * WhopClip chain engine — fully automatic campaign pipeline.
 *
 * One chain per (device_id, campaign_id). Stages:
 *   check -> join -> render -> post -> verify -> submit -> done
 *
 * The phone and the VM worker only ever complete the job in front of them;
 * the server advances the chain:
 *   - POST /api/jobs/:id      (job done)  -> advanceChain()
 *   - POST /api/render/result (render ok) -> advanceChain() past render
 *
 * Idempotent: a chain advances one stage at a time and only when the
 * completed job/render matches the chain's current stage. Re-deliveries and
 * retries are safe. Anything ambiguous fails the chain CLOSED with a reason
 * instead of guessing the next step.
 */
import crypto from "crypto";
import {
  alreadySubmitted,
  enqueueJob,
  getCampaign,
  getJob,
  kv,
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
  verifyReelJob,
  whopSubmitJob,
} from "./jobs";

export type ChainStage =
  | "check"
  | "join"
  | "render"
  | "post"
  | "verify"
  | "submit"
  | "done";

export type ChainStatus = "active" | "done" | "failed";

export interface Chain {
  id: string;
  device_id: string;
  campaign_id: string;
  campaign_name: string;
  stage: ChainStage;
  status: ChainStatus;
  /** job id currently executing this stage (phone-side stages) */
  job_id: string | null;
  /** render spec id (render stage) */
  render_id: string | null;
  /** extracted post URL (post stage output) */
  ig_post_url: string | null;
  /** parsed requirements (from check stage) */
  requirements_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const chainKey = (id: string) => `chain:${id}`;
const chainIdxKey = (device_id: string, campaign_id: string) =>
  `chain_idx:${device_id}:${campaign_id}`;

async function getIdx(key: string): Promise<string[]> {
  const v = (await kv.get(key)) as unknown;
  return Array.isArray(v) ? (v as string[]) : [];
}

async function saveChain(c: Chain): Promise<void> {
  c.updated_at = new Date().toISOString();
  await kv.set(chainKey(c.id), c);
  const idx = await getIdx(chainIdxKey(c.device_id, c.campaign_id));
  if (!idx.includes(c.id)) {
    idx.push(c.id);
    await kv.set(chainIdxKey(c.device_id, c.campaign_id), idx);
  }
}

export async function getChain(id: string): Promise<Chain | null> {
  const v = (await kv.get(chainKey(id))) as unknown;
  return (v as Chain) ?? null;
}

export async function listChains(
  device_id: string,
  campaign_id: string
): Promise<Chain[]> {
  const ids = await getIdx(chainIdxKey(device_id, campaign_id));
  const out: Chain[] = [];
  for (const id of ids) {
    const c = await getChain(id);
    if (c) out.push(c);
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** The newest non-failed chain for this device+campaign, if any. */
export async function activeChain(
  device_id: string,
  campaign_id: string
): Promise<Chain | null> {
  const chains = await listChains(device_id, campaign_id);
  return chains.find((c) => c.status === "active") ?? null;
}

const STAGE_ORDER: ChainStage[] = [
  "check",
  "join",
  "render",
  "post",
  "verify",
  "submit",
  "done",
];

function failChain(c: Chain, error: string): Promise<void> {
  c.status = "failed";
  c.error = error;
  return saveChain(c);
}

async function enqueuePhoneJob(
  device_id: string,
  campaign_id: string,
  type: string,
  steps: Record<string, unknown>[],
  payload?: Record<string, unknown>
): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    id: crypto.randomUUID(),
    device_id,
    type,
    status: "queued",
    steps,
    payload,
    campaign_id,
    result: null,
    created_at: now,
    updated_at: now,
  };
  await enqueueJob(job);
  return job;
}

/**
 * Start a chain for a campaign. Fails closed when:
 * - a chain is already active for this device+campaign
 * - the campaign was already submitted by this device
 * - no device_id
 */
export async function startChain(
  device_id: string,
  campaign: Campaign
): Promise<Chain> {
  if (!device_id) throw new Error("device_id required");
  if (await alreadySubmitted(device_id, campaign.id)) {
    throw new Error(`campaign "${campaign.name}" already submitted — chain refused`);
  }
  const existing = await activeChain(device_id, campaign.id);
  if (existing) {
    throw new Error(
      `chain ${existing.id} already active at stage ${existing.stage}`
    );
  }
  const now = new Date().toISOString();
  const chain: Chain = {
    id: crypto.randomUUID(),
    device_id,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    stage: "check",
    status: "active",
    job_id: null,
    render_id: null,
    ig_post_url: null,
    requirements_json: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  const job = await enqueuePhoneJob(
    device_id,
    campaign.id,
    "whop_check_join",
    checkJoinJob(campaign)
  );
  chain.job_id = job.id;
  await saveChain(chain);
  return chain;
}

function resultStr(result: unknown, key: string): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const v = r[key];
  if (typeof v === "string") return v;
  return "";
}

/**
 * Advance a chain after a phone job completed.
 * Called from POST /api/jobs/:id. Only acts when the finished job is the
 * chain's current stage job; anything else is ignored (idempotent).
 */
export async function onJobDone(job: Job): Promise<Chain | null> {
  if (!job.campaign_id) return null;
  const chain = await activeChain(job.device_id, job.campaign_id);
  if (!chain || chain.job_id !== job.id) return null;
  if (chain.status !== "active") return chain;

  const stageIdx = STAGE_ORDER.indexOf(chain.stage);

  try {
    switch (chain.stage) {
      case "check": {
        const joinState = resultStr(job.result, "join_state").toLowerCase();
        const briefText = resultStr(job.result, "requirements_text");
        if (briefText.length < 50) {
          await failChain(chain, "check produced no usable requirements_text");
          return chain;
        }
        const extraction = extractRequirementsFromText(briefText);
        if (!extraction.complete) {
          await failChain(
            chain,
            `requirements incomplete: ${extraction.missing.join("; ")}`
          );
          return chain;
        }
        chain.requirements_json = JSON.stringify({
          requirements: extraction.requirements,
          authorized_sources: extraction.authorized_sources,
          title_templates: extraction.title_templates,
        });
        const campaign = await getCampaign(chain.campaign_id);
        if (!campaign) {
          await failChain(chain, "campaign vanished mid-chain");
          return chain;
        }
        // Persist the parsed brief + join state on the campaign record so
        // the dashboard and future runs see the ground truth.
        const alreadyJoined = joinState === "joined" || campaign.joined;
        await upsertCampaign({
          ...campaign,
          requirements: extraction.requirements,
          joined: alreadyJoined,
          updated_at: new Date().toISOString(),
        });
        if (alreadyJoined) {
          // skip join -> straight to render
          chain.stage = "render";
          await enqueueRenderStage(chain, campaign, extraction);
        } else if (joinState === "not_joined") {
          chain.stage = "join";
          const j = await enqueuePhoneJob(
            chain.device_id,
            chain.campaign_id,
            "whop_join",
            joinJob(campaign)
          );
          chain.job_id = j.id;
          await saveChain(chain);
        } else {
          await failChain(
            chain,
            `ambiguous join_state "${joinState}" — refusing to guess`
          );
        }
        return chain;
      }

      case "join": {
        const campaign = await getCampaign(chain.campaign_id);
        if (!campaign) {
          await failChain(chain, "campaign vanished mid-chain");
          return chain;
        }
        // The join job's js step throws unless the page shows a joined state,
        // so reaching here means join succeeded — persist it.
        await upsertCampaign({
          ...campaign,
          joined: true,
          updated_at: new Date().toISOString(),
        });
        const parsed = JSON.parse(chain.requirements_json ?? "{}");
        chain.stage = "render";
        await enqueueRenderStage(chain, campaign, {
          requirements: parsed.requirements,
          authorized_sources: parsed.authorized_sources ?? [],
          title_templates: parsed.title_templates ?? [],
        });
        return chain;
      }

      case "post": {
        // Normalize: the phone reports `post_url`; accept `ig_post_url` too.
        const postUrl =
          resultStr(job.result, "post_url") || resultStr(job.result, "ig_post_url");
        if (!/^https?:\/\//i.test(postUrl)) {
          await failChain(chain, "post job finished without a valid post_url");
          return chain;
        }
        chain.ig_post_url = postUrl;
        chain.stage = "verify";
        const j = await enqueuePhoneJob(
          chain.device_id,
          chain.campaign_id,
          "ig_verify",
          verifyReelJob(postUrl),
          { ig_post_url: postUrl }
        );
        chain.job_id = j.id;
        await saveChain(chain);
        return chain;
      }

      case "verify": {
        const campaign = await getCampaign(chain.campaign_id);
        if (!campaign || !chain.ig_post_url) {
          await failChain(chain, "verify done but campaign/post URL missing");
          return chain;
        }
        // Fail-closed frame proof: the verify job must have uploaded all four
        // live-reel frames (1s/7s/15s/25s). Missing proof = no submit.
        const frameKeys = ["frame_1s.png", "frame_7s.png", "frame_15s.png", "frame_25s.png"];
        const missingFrames = frameKeys.filter(
          (k) => !/^https?:\/\//i.test(resultStr(job.result, `${k}_url`))
        );
        if (missingFrames.length > 0) {
          await failChain(
            chain,
            `verify incomplete: missing frame uploads (${missingFrames.join(", ")})`
          );
          return chain;
        }
        chain.stage = "submit";
        const j = await enqueuePhoneJob(
          chain.device_id,
          chain.campaign_id,
          "whop_submit",
          whopSubmitJob({
            campaign_url: campaign.whop_url,
            ig_post_url: chain.ig_post_url,
          }),
          { ig_post_url: chain.ig_post_url }
        );
        chain.job_id = j.id;
        await saveChain(chain);
        return chain;
      }

      case "submit": {
        // submission recording happens in POST /api/jobs/:id already
        chain.stage = "done";
        chain.status = "done";
        chain.job_id = null;
        await saveChain(chain);
        return chain;
      }

      default:
        return chain;
    }
  } catch (e: unknown) {
    await failChain(
      chain,
      `chain advance failed at ${chain.stage}: ${e instanceof Error ? e.message : "unknown"}`
    );
    return chain;
  }
}

async function enqueueRenderStage(
  chain: Chain,
  campaign: Campaign,
  extraction: {
    requirements: unknown;
    authorized_sources: string[];
    title_templates: string[];
  }
): Promise<void> {
  const { buildRenderSpec: build, enqueueRender: enq } = await import("./render");
  const spec = build(chain.device_id, campaign, extraction.requirements as never, {
    authorized_sources: extraction.authorized_sources,
    title_templates: extraction.title_templates,
  });
  await enq(spec);
  chain.render_id = spec.id;
  chain.job_id = null; // render is VM-side, no phone job
  await saveChain(chain);
}

/**
 * Build the Instagram caption for the post stage.
 * - Exact caption_template from the brief wins when present.
 * - Otherwise compose from the brief's own parts: first title template (or
 *   campaign name) + required @mentions + required #hashtags. This is only
 *   reached when the brief does NOT demand an exact caption (the extractor
 *   fail-closes on that), so composing is compliant.
 */
function buildCaption(
  parsed: {
    requirements?: {
      caption_template?: string | null;
      required_mentions?: string[];
      required_hashtags?: string[];
    };
    title_templates?: string[];
  },
  campaignName: string
): string {
  const req = parsed.requirements ?? {};
  if (req.caption_template && req.caption_template.trim().length >= 4) {
    return req.caption_template.trim();
  }
  const lines: string[] = [];
  const title = (parsed.title_templates ?? [])[0]?.trim() || campaignName;
  if (title) lines.push(title);
  const tags = [
    ...(req.required_mentions ?? []),
    ...(req.required_hashtags ?? []),
  ].filter((t, i, a) => t && a.indexOf(t) === i);
  if (tags.length) lines.push(tags.join(" "));
  return lines.join("\n").trim();
}

/**
 * Advance a chain after the VM worker reported a render result.
 * Called from POST /api/render/result. Only acts when the render id matches
 * the chain's current render stage.
 */
export async function onRenderDone(
  render_id: string,
  ok: boolean,
  video_url?: string
): Promise<Chain | null> {
  const spec = await getRender(render_id);
  if (!spec) return null;
  const chain = await activeChain(spec.device_id, spec.campaign_id);
  if (!chain || chain.stage !== "render" || chain.render_id !== render_id) {
    return chain;
  }
  if (!ok) {
    await failChain(chain, "render worker failed (see render spec error)");
    return chain;
  }
  if (!video_url || !/^https?:\/\//i.test(video_url)) {
    await failChain(chain, "render ok but no video_url");
    return chain;
  }
  const parsed = JSON.parse(chain.requirements_json ?? "{}");
  const campaign = await getCampaign(chain.campaign_id);
  const caption = buildCaption(parsed, campaign?.name ?? chain.campaign_name);
  if (!caption) {
    await failChain(chain, "render done but no caption could be built");
    return chain;
  }
  chain.stage = "post";
  const job = await enqueuePhoneJob(
    chain.device_id,
    chain.campaign_id,
    "ig_post",
    igPostJob({ caption, video_hint: video_url }),
    { video_url }
  );
  chain.job_id = job.id;
  await saveChain(chain);
  return chain;
}

/**
 * Mark the chain's current phone job as failed (called when the job fails).
 * Fails the chain closed with the job's error.
 */
export async function onJobFailed(job: Job, error: string): Promise<Chain | null> {
  if (!job.campaign_id) return null;
  const chain = await activeChain(job.device_id, job.campaign_id);
  if (!chain || chain.job_id !== job.id) return null;
  await failChain(chain, `stage ${chain.stage} job failed: ${error.slice(0, 300)}`);
  return chain;
}
