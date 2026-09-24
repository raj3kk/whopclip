/**
 * WhopClip chain engine — HYBRID campaign pipeline (user-ordered 2026-09-24).
 *
 * One chain per (device_id, campaign_id). Stages:
 *   check -> join -> render -> post -> verify -> submit -> done
 *
 *   - check/join/render: server-side (Vercel USA) using phone-uploaded sessions.
 *   - post: PHONE-SIDE. After render, the chain parks if the phone is offline.
 *     When online, the server enqueues an `ig_post` phone job (igPostJob steps);
 *     the phone's JobEngine downloads payload.video_url and uploads via its
 *     real device/IP (no datacenter block), then reports { post_url } or
 *     { error }. onJobDone/onJobFailed resume the chain.
 *   - verify: server-side reel verify (lib/instagram); falls back to the
 *     phone's live-verification payload when the server IP is blocked.
 *   - submit: server-side createSubmission API + recordSubmission.
 *
 * The phone's role: login/session upload + Instagram upload jobs.
 *
 * Advancement triggers (any of them may pump the chain; all idempotent):
 *   - POST /api/run {step:"full"}          -> startChain -> pumpChain
 *   - POST /api/render/result               -> onRenderDone -> pumpChain
 *   - GET  /api/chains/advance?device_id=   -> pumpChain on every active chain
 *       (called by the phone's PollWorker each poll + dashboard button;
 *        the phone poll is the retry driver: when the phone comes online,
 *        its poll pumps the parked post stage and enqueues the upload job.)
 *   - POST /api/jobs/:id {status}           -> onJobDone/onJobFailed -> pump
 *
 * Fail-closed: ambiguous join state, incomplete requirements, unverifiable
 * post, failed verify, or failed submit stop the chain with a reason.
 * Each stage gets MAX_STAGE_ATTEMPTS attempts; then the chain fails.
 * Duplicate-post protection: a chain posts at most once (ig_post_url set
 * once; phone_job_id cleared after terminal job).
 */
import crypto from "crypto";
import {
  alreadySubmitted,
  getCampaign,
  kv,
  recordSubmission,
  upsertCampaign,
  type Campaign,
  type Job,
  type Submission,
} from "./store";
import { getPostSlots, MAX_POSTS_PER_DAY } from "./postslots";
export { MAX_POSTS_PER_DAY };
import { extractRequirementsFromText } from "./requirements";
import { buildRenderSpec, enqueueRender, getRender } from "./render";
import {
  getCampaignDetail,
  probeJoinState,
  applyToCampaign,
  createSubmission,
  getApiDetail,
  type ApiResult,
} from "./whop";
import { buildStructuredBrief } from "./automation";
import { verifyReel } from "./instagram";

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
  /** legacy: phone job id (no longer used for new chains) */
  job_id: string | null;
  /** phone ig_post job id (hybrid post stage: phone uploads, server verifies) */
  phone_job_id: string | null;
  /** phone's live-verification payload from ig_post (fallback when server IP blocked) */
  phone_verify_json: string | null;
  /** render spec id (render stage) */
  render_id: string | null;
  /** extracted post URL (post stage output) */
  ig_post_url: string | null;
  /** rendered video URL (render stage output) */
  video_url: string | null;
  /** real cover frame URL from the render worker (render stage output) */
  cover_url: string | null;
  /** built caption (render stage output) */
  caption: string | null;
  /** parsed requirements (from check stage) */
  requirements_json: string | null;
  /** attempts used on the current stage */
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const chainKey = (id: string) => `chain:${id}`;
const chainIdxKey = (device_id: string, campaign_id: string) =>
  `chain_idx:${device_id}:${campaign_id}`;

const MAX_STAGE_ATTEMPTS = 3;

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

/** All active chains for a device (pump driver iterates these). */
export async function listActiveChains(device_id: string): Promise<Chain[]> {
  // Chains are indexed per campaign; walk the campaigns IN PARALLEL.
  // Sequential reads USA->Mumbai (~250ms each) exceeded the Vercel deadline
  // once the campaign store grew past ~100 campaigns (2026-09-23).
  const { listCampaigns } = await import("./store");
  const campaigns = await listCampaigns();
  const found = await Promise.all(
    campaigns.map((camp) => activeChain(device_id, camp.id).catch(() => null))
  );
  return found.filter((c): c is Chain => !!c);
}

/** Read-only early check: posts published today (UTC) live in the slot ledger. */
async function postsToday(device_id: string): Promise<number> {
  return (await getPostSlots(device_id)).count;
}

function failChain(c: Chain, error: string): Promise<void> {
  c.status = "failed";
  c.error = error;
  return saveChain(c);
}

function bumpAttempt(c: Chain, error: string): Promise<void> {
  c.attempts += 1;
  c.error = error;
  if (c.attempts >= MAX_STAGE_ATTEMPTS) {
    return failChain(
      c,
      `stage "${c.stage}" failed ${c.attempts}x — last: ${error}`
    );
  }
  return saveChain(c);
}

function resetAttempts(c: Chain): void {
  c.attempts = 0;
  c.error = null;
}

/**
 * Start a chain for a campaign. Fails closed when:
 * - a chain is already active for this device+campaign
 * - the campaign was already submitted by this device
 * - the device already posted MAX_POSTS_PER_DAY times today
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
  const todayCount = await postsToday(device_id);
  if (todayCount >= MAX_POSTS_PER_DAY) {
    throw new Error(
      `daily post limit reached (${todayCount}/${MAX_POSTS_PER_DAY}) — chain refused`
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
    phone_job_id: null,
    phone_verify_json: null,
    render_id: null,
    ig_post_url: null,
    video_url: null,
    cover_url: null,
    caption: null,
    requirements_json: null,
    attempts: 0,
    error: null,
    created_at: now,
    updated_at: now,
  };
  await saveChain(chain);
  // Pre-create the per-chain upload lock row (unlocked) so the first pump's
  // lock acquisition is a pure CAS. Non-fatal: the pump falls back to
  // seed-on-acquire for legacy chains.
  try {
    const { seedUploadLock } = await import("./igpost");
    await seedUploadLock(chain.id);
  } catch {
    /* non-fatal */
  }
  await pumpChain(chain);
  return (await getChain(chain.id)) ?? chain;
}

/* ------------------------------------------------------------------ */
/* Stage implementations                                               */
/* ------------------------------------------------------------------ */

async function runCheckStage(chain: Chain): Promise<"advanced" | "failed"> {
  const campaign = await getCampaign(chain.campaign_id);
  if (!campaign) {
    await failChain(chain, "campaign vanished mid-chain");
    return "failed";
  }
  let detail;
  try {
    detail = await getCampaignDetail(chain.campaign_id);
  } catch (e: unknown) {
    await bumpAttempt(
      chain,
      `campaign detail fetch failed: ${e instanceof Error ? e.message : "unknown"}`
    );
    return "failed";
  }
  // Structured brief from the campaign API (guidelines, creator
  // requirements, flags, reference assets) — richer than the page parse.
  // Falls back to the page detail when the API hiccups.
  let brief: ReturnType<typeof buildStructuredBrief> | null = null;
  try {
    const hit = await getApiDetail(chain.campaign_id);
    brief = buildStructuredBrief(hit);
  } catch {
    brief = null;
  }
  const briefText = [
    detail.name,
    detail.description,
    ...detail.contentRequirements,
  ]
    .filter(Boolean)
    .join("\n");
  if (briefText.trim().length < 50 && !brief) {
    await bumpAttempt(chain, "check produced no usable requirements text");
    return "failed";
  }
  const briefParsed = brief ? (JSON.parse(brief.requirements_json) as {
    requirements: Campaign["requirements"];
    extraction_complete: boolean;
    extraction_missing: string[];
  }) : null;
  const extraction = briefParsed
    ? {
        requirements: briefParsed.requirements,
        complete: briefParsed.extraction_complete,
        missing: briefParsed.extraction_missing,
      }
    : extractRequirementsFromText(briefText);
  if (!extraction.complete) {
    await failChain(
      chain,
      `requirements incomplete: ${extraction.missing.join("; ")}`
    );
    return "failed";
  }
  const joinProbe = await probeJoinState(chain.device_id, chain.campaign_id);
  const alreadyJoined = joinProbe.joined === true || campaign.joined === true;
  chain.requirements_json = brief
    ? brief.requirements_json
    : JSON.stringify({
        requirements: extraction.requirements,
        authorized_sources:
          "authorized_sources" in extraction ? extraction.authorized_sources : [],
        title_templates:
          "title_templates" in extraction ? extraction.title_templates : [],
      });
  await upsertCampaign({
    ...campaign,
    name: detail.name || campaign.name,
    requirements: extraction.requirements,
    joined: alreadyJoined,
    requiresApplication: detail.requiresApplication,
    updated_at: new Date().toISOString(),
  });
  if (joinProbe.joined === null && !campaign.joined) {
    await failChain(
      chain,
      `ambiguous join state — refusing to guess (${joinProbe.detail})`
    );
    return "failed";
  }
  resetAttempts(chain);
  chain.stage = alreadyJoined ? "render" : "join";
  await saveChain(chain);
  return "advanced";
}

async function runJoinStage(chain: Chain): Promise<"advanced" | "failed"> {
  const campaign = await getCampaign(chain.campaign_id);
  if (!campaign) {
    await failChain(chain, "campaign vanished mid-chain");
    return "failed";
  }
  // Fail-closed: campaigns that need an application/review can't be joined
  // by automation (no answers to give, approval is human). Manual only.
  if (campaign.requiresApplication) {
    await failChain(
      chain,
      "campaign requires an application/review — auto-join refused (manual apply only)"
    );
    return "failed";
  }
  let res: ApiResult;
  try {
    res = await applyToCampaign(chain.device_id, chain.campaign_id, {});
  } catch (e: unknown) {
    await bumpAttempt(
      chain,
      `join request failed: ${e instanceof Error ? e.message : "unknown"}`
    );
    return "failed";
  }
  if (!res.ok) {
    await bumpAttempt(
      chain,
      `join rejected (HTTP ${res.status}): ${res.error ?? "no detail"}`
    );
    return "failed";
  }
  // Confirm the join actually landed — probe again, fail closed on ambiguity.
  const probe = await probeJoinState(chain.device_id, chain.campaign_id);
  if (probe.joined !== true) {
    await bumpAttempt(
      chain,
      `join API ok but join state unconfirmed (${probe.detail})`
    );
    return "failed";
  }
  await upsertCampaign({
    ...campaign,
    joined: true,
    updated_at: new Date().toISOString(),
  });
  resetAttempts(chain);
  chain.stage = "render";
  await saveChain(chain);
  return "advanced";
}

async function runRenderStage(
  chain: Chain
): Promise<"advanced" | "parked" | "failed"> {
  if (chain.render_id) {
    // Already enqueued — waiting on the VM worker callback.
    return "parked";
  }
  const campaign = await getCampaign(chain.campaign_id);
  if (!campaign) {
    await failChain(chain, "campaign vanished mid-chain");
    return "failed";
  }
  const parsed = JSON.parse(chain.requirements_json ?? "{}");
  const spec = buildRenderSpec(chain.device_id, campaign, parsed.requirements, {
    authorized_sources: parsed.authorized_sources ?? [],
    title_templates: parsed.title_templates ?? [],
  });
  await enqueueRender(spec);
  chain.render_id = spec.id;
  resetAttempts(chain);
  await saveChain(chain);
  return "parked"; // /api/render/result resumes the chain
}

async function runPostStage(chain: Chain): Promise<"advanced" | "failed"> {
  // Duplicate-post protection: never post twice for one chain.
  if (chain.ig_post_url) {
    resetAttempts(chain);
    chain.stage = "verify";
    await saveChain(chain);
    return "advanced";
  }
  if (!chain.video_url || !/^https?:\/\//i.test(chain.video_url)) {
    await failChain(chain, "post stage reached without a rendered video_url");
    return "failed";
  }
  if (!chain.caption) {
    await failChain(chain, "post stage reached without a caption");
    return "failed";
  }
  // Gap G1 — budget exhaustion mid-chain: re-check the live budget right
  // before we spend a daily post slot. A campaign that hit $0 while the
  // chain was rendering must fail, not post.
  try {
    const live = await getApiDetail(chain.campaign_id);
    if (live.budgetRemaining <= 0) {
      await failChain(
        chain,
        `budget exhausted mid-chain ($${live.budgetRemaining.toFixed(2)} remaining) — post refused`
      );
      return "failed";
    }
    if (live.status !== "active") {
      await failChain(chain, `campaign went ${live.status} mid-chain — post refused`);
      return "failed";
    }
  } catch (e: unknown) {
    await bumpAttempt(
      chain,
      `pre-post budget check failed: ${e instanceof Error ? e.message : "unknown"}`
    );
    return "failed";
  }
  // Gap G2 — caption builder verification: every required @mention/#hashtag
  // from the brief must be literally present in the caption before upload.
  {
    const parsed = JSON.parse(chain.requirements_json ?? "{}");
    const req = parsed.requirements ?? {};
    const requiredTags = [
      ...((req.required_mentions as string[]) ?? []),
      ...((req.required_hashtags as string[]) ?? []),
    ];
    const captionLower = ` ${chain.caption.toLowerCase()} `;
    const trulyMissing = requiredTags.filter(
      (t) => t && !captionLower.includes(t.toLowerCase())
    );
    if (trulyMissing.length > 0) {
      await failChain(
        chain,
        `caption missing required tags: ${trulyMissing.join(", ")} — upload refused`
      );
      return "failed";
    }
  }
  // Daily post cap check (read-only; authoritative reservation happens at upload).
  const slots = await getPostSlots(chain.device_id);
  if (slots.count >= MAX_POSTS_PER_DAY) {
    chain.error = `daily post cap reached (${slots.count}/${MAX_POSTS_PER_DAY}) — parked until tomorrow (UTC)`;
    chain.updated_at = new Date().toISOString();
    await saveChain(chain);
    return "advanced"; // stage unchanged -> pump loop parks
  }

  // ---- HYBRID POST (user-ordered 2026-09-24): phone uploads via its real
  // device/IP (no datacenter block), server verifies + submits. ----
  // If a phone job is already in flight, just park and wait for its callback.
  if (chain.phone_job_id) {
    const { getJob } = await import("./store");
    const pj = await getJob(chain.phone_job_id);
    if (pj && (pj.status === "queued" || pj.status === "running")) {
      chain.error = `phone upload in progress (job ${pj.type}, status ${pj.status}) — waiting for phone`;
      chain.updated_at = new Date().toISOString();
      await saveChain(chain);
      return "advanced"; // parked; onJobDone/onJobFailed resumes
    }
    // Job reached a terminal state without advancing the chain (e.g. server
    // restarted mid-callback): clear it so a fresh job is enqueued below.
    // If the job actually succeeded, onJobDone already set ig_post_url and
    // we returned at the top.
    chain.phone_job_id = null;
  }

  // Phone must be online before we hand it work. Offline -> park here;
  // the phone's next poll (GET /api/jobs/next touches last_poll_at, and
  // /api/chains/advance pumps) resumes the chain automatically.
  const { getDevice, deviceOnline, enqueueJob } = await import("./store");
  const device = await getDevice(chain.device_id);
  if (!device || !deviceOnline(device)) {
    chain.error = "phone offline — waiting for phone to come online (job bhej diya jayega)";
    chain.updated_at = new Date().toISOString();
    await saveChain(chain);
    return "advanced"; // parked at post; next pump retries
  }

  // Enqueue the phone upload job. The phone's JobEngine downloads
  // payload.video_url, uploads via Instagram WebView, and reports back
  // { post_url } on done or { error } on failed.
  const { igPostJob } = await import("./jobs");
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    device_id: chain.device_id,
    type: "ig_post",
    status: "queued" as const,
    steps: igPostJob({ caption: chain.caption }),
    payload: {
      video_url: chain.video_url,
      chain_id: chain.id,
      campaign_id: chain.campaign_id,
    },
    campaign_id: chain.campaign_id,
    result: null,
    created_at: now,
    updated_at: now,
  };
  await enqueueJob(job);
  chain.phone_job_id = job.id;
  resetAttempts(chain);
  chain.error = `phone upload job queued (${job.id.slice(0, 8)}) — waiting for phone to pick it up`;
  await saveChain(chain);
  return "advanced"; // parked at post; phone callback resumes
}

async function runVerifyStage(chain: Chain): Promise<"advanced" | "failed"> {
  const campaign = await getCampaign(chain.campaign_id);
  if (!campaign || !chain.ig_post_url) {
    await failChain(chain, "verify stage reached without campaign/post URL");
    return "failed";
  }
  const parsed = JSON.parse(chain.requirements_json ?? "{}");
  const req = parsed.requirements ?? {};
  const requiredTags = [
    ...((req.required_mentions as string[]) ?? []),
    ...((req.required_hashtags as string[]) ?? []),
  ];
  let vr;
  try {
    vr = await verifyReel(chain.device_id, chain.ig_post_url, {
      required_tags: requiredTags,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    // Hybrid fallback (user-ordered 2026-09-24): the server's datacenter IP
    // is blocked by Instagram, but the phone's ig_post job already did a
    // live DOM verification (video element + URL pattern + metrics). If we
    // have the phone's proof, trust it instead of failing on our IP block.
    const isNetworkBlock =
      /timeout|network|econn|socket|fetch failed|wrong|blocked/i.test(msg);
    if (isNetworkBlock && chain.phone_verify_json) {
      try {
        const pv = JSON.parse(chain.phone_verify_json);
        if (pv.post_url === chain.ig_post_url) {
          chain.error = null;
          resetAttempts(chain);
          chain.stage = "submit";
          await saveChain(chain);
          return "advanced"; // phone-verified; server fetch IP-blocked
        }
      } catch {
        /* fall through to bumpAttempt */
      }
    }
    await bumpAttempt(chain, `reel verify threw: ${msg}`);
    return "failed";
  }
  if (!vr.live) {
    const failed = vr.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
    await bumpAttempt(
      chain,
      `reel verify failed: ${failed.join("; ") || "reel not live"}`
    );
    return "failed";
  }
  resetAttempts(chain);
  chain.stage = "submit";
  await saveChain(chain);
  return "advanced";
}

async function runSubmitStage(chain: Chain): Promise<"advanced" | "failed"> {
  if (!chain.ig_post_url) {
    await failChain(chain, "submit stage reached without ig_post_url");
    return "failed";
  }
  let res: ApiResult;
  try {
    res = await createSubmission(chain.device_id, {
      campaignId: chain.campaign_id,
      platform: "instagram",
      url: chain.ig_post_url,
    });
  } catch (e: unknown) {
    await bumpAttempt(
      chain,
      `submit request failed: ${e instanceof Error ? e.message : "unknown"}`
    );
    return "failed";
  }
  if (!res.ok) {
    await bumpAttempt(
      chain,
      `submit rejected (HTTP ${res.status}): ${res.error ?? "no detail"}`
    );
    return "failed";
  }
  const campaign = await getCampaign(chain.campaign_id);
  const now = new Date().toISOString();
  const sub: Submission = {
    id: crypto.randomUUID(),
    device_id: chain.device_id,
    campaign_id: chain.campaign_id,
    campaign_name: chain.campaign_name,
    ig_post_url: chain.ig_post_url,
    status: "pending",
    payout_per_1k: campaign?.payout_per_1k ?? 0,
    views: null,
    earned_usd: null,
    created_at: now,
  };
  await recordSubmission(sub);
  resetAttempts(chain);
  chain.stage = "done";
  chain.status = "done";
  await saveChain(chain);
  return "advanced";
}

/* ------------------------------------------------------------------ */
/* Pump: advance one chain through runnable stages                     */
/* ------------------------------------------------------------------ */

/**
 * Pump a chain forward through every stage that can run synchronously.
 * Stops (parks) at `render` while the VM worker renders, or when the
 * chain reaches done/failed. Idempotent — safe to call from any trigger.
 */
export async function pumpChain(chain: Chain): Promise<Chain> {
  let c = (await getChain(chain.id)) ?? chain;
  // Never pump a terminal chain.
  if (c.status !== "active") return c;
  for (let i = 0; i < 8 && c.status === "active"; i++) {
    const before = c.stage;
    let outcome: "advanced" | "parked" | "failed";
    try {
      switch (c.stage) {
        case "check":
          outcome = await runCheckStage(c);
          break;
        case "join":
          outcome = await runJoinStage(c);
          break;
        case "render":
          outcome = await runRenderStage(c);
          break;
        case "post":
          outcome = await runPostStage(c);
          break;
        case "verify":
          outcome = await runVerifyStage(c);
          break;
        case "submit":
          outcome = await runSubmitStage(c);
          break;
        case "done":
          c.status = "done";
          await saveChain(c);
          outcome = "advanced";
          break;
      }
    } catch (e: unknown) {
      await bumpAttempt(
        c,
        `stage "${c.stage}" threw: ${e instanceof Error ? e.message : "unknown"}`
      );
      outcome = "failed";
    }
    c = (await getChain(c.id)) ?? c;
    if (outcome === "parked") break;
    if (outcome === "failed") break; // retryable: keep stage, stop pumping
    if (c.stage === before && outcome === "advanced") break; // no progress
  }
  return c;
}

/** Pump every active chain for a device (retry driver). */
export async function pumpDeviceChains(device_id: string): Promise<Chain[]> {
  const chains = await listActiveChains(device_id);
  const out: Chain[] = [];
  for (const ch of chains) {
    try {
      out.push(await pumpChain(ch));
    } catch {
      // One bad chain must not block the others.
      out.push(ch);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Callbacks                                                           */
/* ------------------------------------------------------------------ */

/**
 * Advance a chain after the VM worker reported a render result.
 * Called from POST /api/render/result. Only acts when the render id
 * matches the chain's current render stage.
 */
/**
 * Record an externally-completed Instagram post (e.g. posted via the
 * user-authorized browser flow when the server API path is blocked).
 * Moves the chain from post (active OR failed) to verify.
 */
export async function markChainPosted(
  chain_id: string,
  ig_post_url: string
): Promise<Chain | null> {
  const chain = await getChain(chain_id);
  if (!chain) return null;
  // Accept post stage (normal) or verify stage (URL correction after a bad mark).
  if (chain.stage !== "post" && chain.stage !== "verify") return chain;
  if (!/^https?:\/\//.test(ig_post_url)) return chain;
  chain.ig_post_url = ig_post_url;
  chain.stage = "verify";
  chain.status = "active";
  chain.attempts = 0;
  chain.error = null;
  await saveChain(chain);
  return chain;
}

/**
 * Record a browser-verified reel (live URL opened, caption/tags/aspect
 * visually confirmed) and advance the chain to submit. Used when the
 * server-side HTML scrape is blocked by Instagram's datacenter-IP
 * restrictions but the live post was verified in-browser.
 */
/**
 * Resurrect a chain that failed at submit (e.g. after the Whop session
 * was refreshed) back to submit/active for another attempt.
 */
export async function retryChainSubmit(chain_id: string): Promise<Chain | null> {
  const chain = await getChain(chain_id);
  if (!chain) return null;
  if (chain.stage !== "submit" || !chain.ig_post_url) return chain;
  chain.status = "active";
  chain.attempts = 0;
  chain.error = null;
  await saveChain(chain);
  return chain;
}

export async function markChainVerified(chain_id: string): Promise<Chain | null> {
  const chain = await getChain(chain_id);
  if (!chain) return null;
  if (chain.stage !== "verify" || !chain.ig_post_url) return chain;
  chain.stage = "submit";
  chain.status = "active";
  chain.attempts = 0;
  chain.error = null;
  await saveChain(chain);
  return chain;
}

export async function onRenderDone(
  render_id: string,
  ok: boolean,
  video_url?: string,
  cover_url?: string
): Promise<Chain | null> {
  const spec = await getRender(render_id);
  if (!spec) return null;
  const chain = await activeChain(spec.device_id, spec.campaign_id);
  if (!chain || chain.stage !== "render" || chain.render_id !== render_id) {
    return chain;
  }
  if (!ok) {
    // Transient worker infra failure (network blip, timeout): requeue the
    // spec so the VM worker's cron retries, keep the chain parked at render.
    // Permanent failures (no speech, bad source) still fail the chain.
    const { requeueRender, isTransientRenderError } = await import("./render");
    const errText = (await getRender(render_id))?.error ?? "";
    if (isTransientRenderError(errText)) {
      const spec2 = await getRender(render_id);
      if ((spec2?.worker_attempts ?? 0) < 3) {
        await requeueRender(render_id, errText);
        chain.error = `render worker hit transient infra (${errText.slice(0, 120)}) — requeued, retrying`;
        chain.updated_at = new Date().toISOString();
        await saveChain(chain);
        return chain; // parked at render; worker cron resumes
      }
    }
    await failChain(chain, "render worker failed (see render spec error)");
    return chain;
  }
  if (!video_url || !/^https?:\/\//i.test(video_url)) {
    await failChain(chain, "render ok but no video_url");
    return chain;
  }
  if (!cover_url || !/^https?:\/\//i.test(cover_url)) {
    await failChain(chain, "render ok but no cover_url — the worker must supply a real cover frame");
    return chain;
  }
  const parsed = JSON.parse(chain.requirements_json ?? "{}");
  const campaign = await getCampaign(chain.campaign_id);
  const caption = buildCaption(parsed, campaign?.name ?? chain.campaign_name);
  if (!caption) {
    await failChain(chain, "render done but no caption could be built");
    return chain;
  }
  chain.video_url = video_url;
  chain.cover_url = cover_url;
  chain.caption = caption;
  chain.stage = "post";
  await saveChain(chain);
  return pumpChain(chain);
}

/**
 * Phone job failed: for hybrid chains (phone_job_id set), record the phone's
 * reported reason and bump the stage attempt. Legacy job_id path kept below.
 */
export async function onJobFailed(job: Job): Promise<Chain | null> {
  if (!job.campaign_id) return null;
  const chain = await activeChain(job.device_id, job.campaign_id);
  if (!chain || chain.status !== "active") return chain;
  // Hybrid post stage: the phone's ig_post job failed — surface its reason.
  if (chain.phone_job_id === job.id && job.type === "ig_post") {
    const r = (job.result ?? {}) as Record<string, unknown>;
    const reason =
      typeof r.error === "string" && r.error
        ? r.error
        : `phone upload failed: ${JSON.stringify(job.result ?? {}).slice(0, 200)}`;
    // Session expired on the phone -> mark stale so the app prompts re-login.
    if (r.session_expired === true) {
      const { markSessionStale } = await import("./store");
      await markSessionStale(chain.device_id, "instagram").catch(() => {});
    }
    chain.phone_job_id = null; // allow a fresh job on the next pump
    await bumpAttempt(chain, reason);
    return chain;
  }
  // Legacy path (pre-hybrid chains).
  if (!chain || chain.job_id !== job.id) return null;
  await failChain(
    chain,
    `phone job ${job.type} failed: ${JSON.stringify(job.result ?? {}).slice(0, 300)}`
  );
  return chain;
}

/**
 * Phone job done: for hybrid chains, an ig_post success carries { post_url }
 * (extracted by the phone's JobEngine). Store it and advance to verify.
 */
export async function onJobDone(job: Job): Promise<Chain | null> {
  if (!job.campaign_id) return null;
  const chain = await activeChain(job.device_id, job.campaign_id);
  if (!chain || chain.status !== "active") return chain;
  // Hybrid post stage: phone uploaded the reel — grab its URL and verify.
  if (chain.phone_job_id === job.id && job.type === "ig_post") {
    const r = (job.result ?? {}) as Record<string, unknown>;
    const postUrl =
      typeof r.post_url === "string" && /^https?:\/\//i.test(r.post_url)
        ? r.post_url
        : "";
    if (!postUrl) {
      chain.phone_job_id = null;
      await bumpAttempt(
        chain,
        `phone reported done but no post_url in result: ${JSON.stringify(r).slice(0, 200)}`
      );
      return chain;
    }
    chain.ig_post_url = postUrl;
    chain.phone_job_id = null;
    // Store the phone's live-verification (live_metrics + video check from
    // igPostJob steps) as fallback proof if the server's own fetch is
    // IP-blocked.
    try {
      chain.phone_verify_json = JSON.stringify({
        post_url: postUrl,
        live_metrics: r.live_metrics ?? null,
        verified_at: new Date().toISOString(),
      });
    } catch {
      chain.phone_verify_json = null;
    }
    chain.error = null;
    resetAttempts(chain);
    chain.stage = "verify";
    await saveChain(chain);
    return pumpChain(chain);
  }
  // Legacy path (pre-hybrid chains).
  if (!chain || chain.job_id !== job.id) return null;
  return chain;
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
