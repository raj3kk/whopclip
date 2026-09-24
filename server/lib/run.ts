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
  listCampaigns,
  selectCampaign,
  upsertCampaign,
  recordSubmission,
  type Campaign,
  type Job,
  type Submission,
} from "./store";
import { extractRequirementsFromText } from "./requirements";
import { buildRenderSpec, enqueueRenderDedup, getRender } from "./render";
import { startChain, type Chain } from "./chain";
import {
  discoverCampaigns,
  cardToCampaign,
  getCampaignDetail,
  probeJoinState,
  applyToCampaign,
  createSubmission,
} from "./whop";
import { verifyReel } from "./instagram";
import { logActivity } from "./store";
import { runAutoDiscover } from "./automation";

/** Default Whop Content Rewards discovery page (overridable per run). */
export const DEFAULT_DISCOVER_URL = "https://whop.com/content-rewards";

export interface RunStepOptions {
  campaign_id?: string;
  caption?: string;
  video_url?: string;
  /** real cover frame URL — required for the post step */
  cover_url?: string;
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

  /**
   * Marker job for a step that ran on the server: status done immediately,
   * result embedded. The dashboard reads these exactly like phone jobs.
   */
  const serverMarker = (
    type: string,
    device_id: string,
    campaign_id: string | undefined,
    result: unknown,
    nowIso: string
  ): Job => ({
    id: `server-${crypto.randomUUID()}`,
    device_id,
    type,
    status: "done",
    steps: [{ action: type }],
    payload: campaign_id ? { campaign_id } : undefined,
    campaign_id,
    result,
    created_at: nowIso,
    updated_at: new Date().toISOString(),
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

  // No stored eligible campaign (or step=full without a specific campaign):
  // auto-discover via the search API, score every campaign with a logged
  // rationale, and start ONE chain on the top eligible pick (fail-closed
  // gates still apply inside startChain/advanceChain). This is the
  // server-side equivalent of the user's in-app flow: search -> scroll ->
  // pick the best.
  if (!campaign && !opts.campaign_id && step === "full") {
    const auto = await runAutoDiscover(device_id, { dryRun: false });
    if (auto.picked && auto.started_chain_id) {
      const autoCamp = await getCampaign(auto.picked.hit.id);
      const job = serverMarker(
        "server_chain",
        device_id,
        auto.picked.hit.id,
        {
          chain_id: auto.started_chain_id,
          auto_discover: true,
          score: auto.picked.score,
          rationale: auto.picked.rationale,
        },
        now
      );
      return {
        job,
        campaign: autoCamp,
        server_result: {
          chain_id: auto.started_chain_id,
          campaign_name: auto.picked.hit.name,
          score: auto.picked.score,
        },
      };
    }
    throw new RunError(
      409,
      `auto-discover: no eligible campaign (${auto.ranked.length} scored, ${auto.ranked.filter((r) => r.excluded).length} excluded)`
    );
  }

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

  switch (step) {
    case "discover": {
      // Server-side discover (Vercel USA) — no phone job, no discover_url
      // needed. The rewards site embeds campaign cards in the SSR payload.
      return serverDiscover();
    }
    case "check": {
      // Server-side (Vercel USA): campaign detail + join-state probe +
      // requirements extraction. No phone WebView.
      const detail = await getCampaignDetail(campaign.id);
      const briefText = [detail.name, detail.description, ...detail.contentRequirements]
        .filter(Boolean)
        .join("\n");
      if (briefText.trim().length < 50) {
        throw new RunError(422, "check: campaign detail has no usable requirements text");
      }
      const extraction = extractRequirementsFromText(briefText);
      const joinProbe = await probeJoinState(device_id, campaign.id);
      const result = {
        campaign: { id: detail.id, name: detail.name, active: detail.status },
        requirements_complete: extraction.complete,
        missing: extraction.missing,
        join_state:
          joinProbe.joined === true ? "joined" : joinProbe.joined === false ? "not_joined" : "unknown",
        join_detail: joinProbe.detail,
      };
      if (!extraction.complete) {
        throw new RunError(
          422,
          `check: incomplete requirements (${extraction.missing.join("; ")})`
        );
      }
      await upsertCampaign({
        ...campaign,
        name: detail.name || campaign.name,
        requirements: extraction.requirements,
        joined: joinProbe.joined === true || campaign.joined === true,
        updated_at: now,
      });
      await logActivity(
        device_id,
        "server_check",
        `Server check: ${campaign.name} — join=${result.join_state}, requirements ok`
      );
      return {
        job: serverMarker("server_check", device_id, campaign.id, result, now),
        campaign,
        server_result: result,
      };
    }
    case "join": {
      // Server-side (Vercel USA): apply API + join-state confirmation.
      if (campaign.joined) {
        throw new RunError(409, "campaign already joined");
      }
      const res = await applyToCampaign(device_id, campaign.id, {});
      if (!res.ok) {
        throw new RunError(
          502,
          `join rejected (HTTP ${res.status}): ${res.error ?? "no detail"}`
        );
      }
      const probe = await probeJoinState(device_id, campaign.id);
      if (probe.joined !== true) {
        throw new RunError(502, `join API ok but join state unconfirmed (${probe.detail})`);
      }
      await upsertCampaign({ ...campaign, joined: true, updated_at: now });
      const result = { joined: true, detail: probe.detail };
      await logActivity(device_id, "server_join", `Server join: ${campaign.name} — joined ✓`);
      return {
        job: serverMarker("server_join", device_id, campaign.id, result, now),
        campaign,
        server_result: result,
      };
    }
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
      const { spec: renderSpec, duplicate } = await enqueueRenderDedup(spec);
      // Return a marker job so the dashboard can track render state.
      // render_clip jobs are server-side; mark done immediately — the VM
      // worker picks up the spec via /api/render/next.
      const renderResult = {
        render_id: renderSpec.id,
        status: duplicate ? renderSpec.status : "queued",
        duplicate,
      };
      return {
        job: serverMarker("render_clip", device_id, campaign.id, renderResult, now),
        campaign,
        server_result: renderResult,
      };
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
      // Server-side (Vercel USA): Instagram reel upload via the saved IG
      // session (lib/igpost). The phone never posts.
      const caption = typeof opts.caption === "string" ? opts.caption : "";
      const video_url = typeof opts.video_url === "string" ? opts.video_url : "";
      const cover_url = typeof opts.cover_url === "string" ? opts.cover_url : "";
      if (!caption || !video_url) {
        throw new RunError(400, "caption and video_url required for post step");
      }
      if (!cover_url) {
        throw new RunError(400, "cover_url required for post step (real frame — no placeholder)");
      }
      const { postReelToInstagram } = await import("./igpost");
      const { createHash } = await import("node:crypto");
      // Standalone run step has no chain — derive a deterministic idempotency
      // key so re-running the same video+caption resumes instead of re-posting.
      const idem = createHash("sha1")
        .update(`${device_id}|${video_url}|${cover_url}|${caption}`)
        .digest("hex")
        .slice(0, 16);
      const res = await postReelToInstagram(device_id, `run-post:${idem}`, video_url, cover_url, caption);
      if (res.phase === "uploading" || res.phase === "transcoding" || res.phase === "busy") {
        throw new RunError(
          202,
          `instagram upload in progress (phase: ${res.phase}) — re-run this step to continue`
        );
      }
      if (!res.ok || !res.post_url) {
        throw new RunError(502, `instagram upload failed: ${res.error ?? "no post_url"}`);
      }
      const result = { post_url: res.post_url, media_id: res.media_id ?? null };
      await logActivity(device_id, "server_post", `Server post: ${res.post_url}`);
      return {
        job: serverMarker("server_post", device_id, campaign.id, result, now),
        campaign,
        server_result: result,
      };
    }
    case "submit": {
      // Server-side (Vercel USA): createSubmission API + recordSubmission.
      const ig_post_url =
        typeof opts.ig_post_url === "string" ? opts.ig_post_url : "";
      if (!ig_post_url) {
        throw new RunError(400, "ig_post_url required for submit step");
      }
      const res = await createSubmission(device_id, {
        campaignId: campaign.id,
        platform: "instagram",
        url: ig_post_url,
      });
      if (!res.ok) {
        throw new RunError(
          502,
          `submit rejected (HTTP ${res.status}): ${res.error ?? "no detail"}`
        );
      }
      const sub: Submission = {
        id: crypto.randomUUID(),
        device_id,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        ig_post_url,
        status: "pending",
        payout_per_1k: campaign.payout_per_1k ?? 0,
        views: null,
        earned_usd: null,
        created_at: now,
      };
      await recordSubmission(sub);
      const result = { submitted: true, submission_id: sub.id, ig_post_url };
      await logActivity(
        device_id,
        "server_submit",
        `Server submit: ${campaign.name} — ${ig_post_url}`
      );
      return {
        job: serverMarker("server_submit", device_id, campaign.id, result, now),
        campaign,
        server_result: result,
      };
    }
    case "full":
    default: {
      // full = startChain(): runs check->join->render on the server NOW
      // (render parks on the VM worker; /api/render/result resumes the
      // chain into post->verify->submit->done). The phone runs nothing.
      // startChain throws on already-active/already-submitted/daily-limit.
      const chain = await startChain(device_id, campaign);
      const result = {
        chain_id: chain.id,
        stage: chain.stage,
        status: chain.status,
        error: chain.error,
      };
      return {
        job: serverMarker("server_chain", device_id, campaign.id, result, now),
        campaign,
        chain,
        server_result: result,
      };
    }
  }
}
