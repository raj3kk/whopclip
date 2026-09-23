/**
 * WhopClip auto-pipeline: search -> score -> select -> chain.
 *
 * The user's requested flow: the Content Rewards app's search box is tapped,
 * "instagram" is typed, results are scrolled and the GOOD campaign(s) are
 * picked automatically. This module does the server-side equivalent:
 *
 *   1. searchCampaigns("instagram") with cursor pagination (the "scroll")
 *   2. explicit scoring with logged rationale per candidate
 *   3. hard exclusion gates (fail-closed): already submitted, $0 budget,
 *      dead/rejected campaigns, requiresApplication (unless already joined),
 *      no Instagram payout, paused/private
 *   4. requirement-fit scoring: our automated clip pipeline can only do
 *      clip-style editing — campaigns demanding original face-to-camera UGC
 *      or pre-approval score down hard (they'd fail at render/verify anyway)
 *   5. top pick -> startChain (or dry-run: return the ranked table only)
 *
 * Nothing here posts, joins, or submits anything. startChain is the only
 * mutation path, and it goes through the chain engine's fail-closed gates.
 */
import {
  searchCampaigns,
  getCampaignFromApi,
  hitToCampaign,
  type SearchHit,
} from "./search";
import {
  alreadySubmitted,
  getCampaign,
  listCampaigns,
  upsertCampaign,
  logActivity,
  kv,
  type Campaign,
} from "./store";
import { extractRequirementsFromText } from "./requirements";
import { startChain } from "./chain";

export const AUTO_SEARCH_QUERY = "instagram";

/**
 * Campaigns that must never be picked again: rejected/closed/dead ones.
 * Name matching is normalized (lowercase, alnum only) and uses "contains".
 */
const DEAD_CAMPAIGN_NAMES = [
  // COD MW4 Beta: submissions closed, $0 remaining (rejected 2026-09-23).
  "mw4beta",
  "modernwarfare4beta",
  "codmw4beta",
];

function normName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isDeadCampaign(name: string): boolean {
  const n = normName(name);
  return DEAD_CAMPAIGN_NAMES.some((d) => n.includes(d));
}

export interface ScoredPick {
  hit: SearchHit;
  score: number;
  excluded: boolean;
  excludeReason: string | null;
  rationale: string[];
}

export interface ScoreContext {
  submittedIds: Set<string>;
  joinedIds: Set<string>;
}

export async function buildScoreContext(device_id: string): Promise<ScoreContext> {
  const campaigns = await listCampaigns();
  const submittedIds = new Set<string>();
  const joinedIds = new Set<string>();
  for (const c of campaigns) {
    if (await alreadySubmitted(device_id, c.id)) submittedIds.add(c.id);
    if (c.joined) joinedIds.add(c.id);
  }
  return { submittedIds, joinedIds };
}

/**
 * Score one campaign 0..1 with explicit rationale.
 * Weights: rate 0.35 | budget 0.25 | requirement-fit 0.25 | platform 0.10 | joined 0.05
 */
export function scoreCampaign(hit: SearchHit, ctx: ScoreContext): ScoredPick {
  const rationale: string[] = [];
  const excl = (reason: string): ScoredPick => ({
    hit,
    score: 0,
    excluded: true,
    excludeReason: reason,
    rationale: [`EXCLUDED: ${reason}`],
  });

  if (hit.status !== "active") return excl(`status=${hit.status} (not active)`);
  if (hit.private) return excl("private campaign");
  if (ctx.submittedIds.has(hit.id)) return excl("already submitted by this device");
  if (isDeadCampaign(hit.name)) return excl("dead/rejected campaign (denylist)");
  if (hit.budgetRemaining <= 0) return excl("budget exhausted ($0 remaining)");
  if (hit.igRatePer1k <= 0) return excl("no Instagram payout");
  if (hit.requiresApplication && !ctx.joinedIds.has(hit.id)) {
    return excl("requires application review — auto-flow can't apply, manual only");
  }

  // 1. rate: $5/1k = excellent
  const rateNorm = Math.min(hit.igRatePer1k / 5, 1);
  rationale.push(`rate $${hit.igRatePer1k.toFixed(2)}/1k -> ${rateNorm.toFixed(2)}`);

  // 2. budget: log scale, $10k ~ full
  const budgetNorm = Math.min(Math.log10(1 + hit.budgetRemaining) / 4, 1);
  rationale.push(`budget $${hit.budgetRemaining.toFixed(0)} left -> ${budgetNorm.toFixed(2)}`);

  // 3. requirement-fit: what our automated clip pipeline can actually do
  let fit = 1;
  const flags = hit.requirementFlags ?? {};
  const videoAssets = hit.assets.filter((a) => a.isVideo);
  const briefProbe = buildStructuredBrief(hit);
  const briefParsed = JSON.parse(briefProbe.requirements_json) as {
    authorized_sources: string[];
    extraction_complete: boolean;
  };
  const hasFootage =
    videoAssets.length > 0 || briefParsed.authorized_sources.length > 0;
  if (!hasFootage) {
    // The chain's check stage fail-closes on missing authorized sources, so
    // picking this campaign could never produce a render. Exclude now with
    // the reason logged, instead of failing a chain later.
    return excl("no downloadable footage source (no video assets, no source URLs)");
  }
  if (flags.faceOnCamera === true) {
    fit -= 0.5;
    rationale.push("fit -0.50: faceOnCamera=true (original UGC — pipeline can't do)");
  }
  if (flags.preApproval === true) {
    fit -= 0.3;
    rationale.push("fit -0.30: preApproval=true (draft review before posting)");
  }
  if (videoAssets.length === 0) {
    fit -= 0.2;
    rationale.push("fit -0.20: no direct video assets (source URL only)");
  }
  if ((hit.guidelines || "").length < 100) {
    fit -= 0.2;
    rationale.push("fit -0.20: guidelines too thin to edit faithfully");
  }
  fit = Math.max(0, Math.min(1, fit));
  rationale.push(`requirement-fit -> ${fit.toFixed(2)}`);

  // 4. platform: instagram payout present (already gated) — bonus when it's
  //    the PRIMARY/only platform (brief written for IG, not a repost afterthought)
  const platforms = new Set(hit.payouts.map((p) => p.platform));
  const platformScore = platforms.has("instagram") ? 1 : 0;
  rationale.push(`platforms: ${[...platforms].join(",") || "?"}`);

  // 5. already joined -> submit flow is ready, no join friction
  const joined = ctx.joinedIds.has(hit.id);
  if (joined) rationale.push("joined already (+0.05): submit flow ready");

  const score =
    0.35 * rateNorm + 0.25 * budgetNorm + 0.25 * fit + 0.1 * platformScore + (joined ? 0.05 : 0);
  rationale.push(`SCORE = ${score.toFixed(3)}`);
  return { hit, score, excluded: false, excludeReason: null, rationale };
}

export interface StructuredBrief {
  requirements_json: string;
  summary: {
    campaign_name: string;
    rate_per_1k: number;
    budget_remaining: number;
    caption_rules: string;
    title_templates: string[];
    video_specs: string[];
    dos_donts: string[];
    assets: { name: string; url: string }[];
    creator_requirements: string;
  };
}

/**
 * Merge the API-structured brief (guidelines, creator requirements, flags,
 * reference assets) with the text extractor (caption template, @mentions,
 * #hashtags, duration cap). The result is what the chain stores in
 * requirements_json and what the render worker consumes.
 */
export function buildStructuredBrief(hit: SearchHit): StructuredBrief {
  const flags = hit.requirementFlags ?? {};
  const flagLines: string[] = [];
  if (flags.caption) flagLines.push(`caption: ${String(flags.caption).trim()}`);
  if (flags.faceOnCamera === true) flagLines.push("face-to-camera required");
  if (flags.linkInBio === true)
    flagLines.push(`link in bio required${flags.linkInBioUrl ? `: ${String(flags.linkInBioUrl).trim()}` : ""}`);
  if (flags.brandLogo === true) flagLines.push("brand logo required");
  if (flags.noRepostedContent === true) flagLines.push("no reposted content");
  if (flags.preApproval === true) flagLines.push("pre-approval required before posting");
  if (flags.videoLength) flagLines.push(`video length: ${String(flags.videoLength)}s`);

  const briefText = [hit.name, hit.description, hit.guidelines, flagLines.join("\n")]
    .filter(Boolean)
    .join("\n\n");
  const extraction = extractRequirementsFromText(briefText);

  const videoAssets = hit.assets.filter((a) => a.isVideo);
  // authorized_sources: DOWNLOADABLE URLs first (the render worker can only
  // fetch direct http(s) URLs). Bare handles / channel pages go last so the
  // worker never picks an unfetchable source while a good one exists.
  const downloadOk = (u: string) =>
    /^https?:\/\//.test(u) && !/\byoutube\.com\/@[A-Za-z0-9_.]+\/?$/.test(u);
  const dedupe = (arr: string[]) => [...new Set(arr)];
  const downloadable = dedupe(
    videoAssets.map((a) => a.url).filter(downloadOk)
  ).concat(dedupe(extraction.authorized_sources.filter(downloadOk)));
  const nonDownloadable = dedupe(
    extraction.authorized_sources
      .filter((u) => !downloadOk(u))
      .concat(videoAssets.map((a) => a.url).filter((u) => !downloadOk(u)))
  );
  const authorized_sources = downloadable.concat(nonDownloadable);

  const requirements_json = JSON.stringify({
    requirements: extraction.requirements,
    authorized_sources,
    title_templates: extraction.title_templates,
    creator_requirements: hit.creatorRequirements,
    requirement_flags: flags,
    content_guidelines: hit.guidelines,
    assets: hit.assets.map((a) => ({ name: a.name, url: a.url, isVideo: a.isVideo })),
    rate_per_1k: hit.igRatePer1k,
    budget_remaining: hit.budgetRemaining,
    requiresApplication: hit.requiresApplication,
    extraction_complete: extraction.complete,
    extraction_missing: extraction.missing,
    extraction_warnings: extraction.warnings,
  });

  const video_specs: string[] = ["9:16 vertical (original, uncropped)"];
  if (extraction.requirements.video_max_duration_s) {
    video_specs.push(`≤ ${extraction.requirements.video_max_duration_s}s`);
  }
  if (flags.videoLength) video_specs.push(`brief: ${String(flags.videoLength)}s`);

  return {
    requirements_json,
    summary: {
      campaign_name: hit.name,
      rate_per_1k: hit.igRatePer1k,
      budget_remaining: hit.budgetRemaining,
      caption_rules: extraction.requirements.caption_template ?? "(none — compose from tags)",
      title_templates: extraction.title_templates,
      video_specs,
      dos_donts: extraction.requirements.posting_rules.slice(0, 12),
      assets: hit.assets.map((a) => ({ name: a.name, url: a.url })),
      creator_requirements: hit.creatorRequirements,
    },
  };
}

export interface AutoDiscoverResult {
  query: string;
  hits_seen: number;
  ranked: Array<{
    id: string;
    name: string;
    score: number;
    excluded: boolean;
    excludeReason: string | null;
    rationale: string[];
    rate_per_1k: number;
    budget_remaining: number;
    requiresApplication: boolean;
    joined: boolean;
    video_assets: number;
  }>;
  picked: ScoredPick | null;
  started_chain_id: string | null;
  dry_run: boolean;
  brief: StructuredBrief["summary"] | null;
}

/** Last auto-discover run per device (dashboard shows it). */
export async function saveAutoDiscoverLog(device_id: string, result: AutoDiscoverResult) {
  await kv.set(`autodisc:${device_id}`, {
    at: new Date().toISOString(),
    query: result.query,
    hits_seen: result.hits_seen,
    ranked: result.ranked,
    picked: result.picked
      ? { id: result.picked.hit.id, name: result.picked.hit.name, score: result.picked.score }
      : null,
    started_chain_id: result.started_chain_id,
    dry_run: result.dry_run,
  });
}

export async function getAutoDiscoverLog(device_id: string): Promise<Record<string, unknown> | null> {
  return ((await kv.get(`autodisc:${device_id}`)) as Record<string, unknown>) ?? null;
}

/**
 * Full auto-pipeline entry: search -> score -> (dry-run | pick top -> chain).
 * Mutations: upserts discovered campaigns into the store; optionally starts
 * one chain via startChain (which enforces all its own gates).
 */
export async function runAutoDiscover(
  device_id: string,
  opts: { query?: string; dryRun?: boolean; maxPages?: number; topN?: number } = {}
): Promise<AutoDiscoverResult> {
  const query = opts.query?.trim() || AUTO_SEARCH_QUERY;
  const dryRun = opts.dryRun !== false; // default dry-run = true (safe)
  const { hits, totalSeen } = await searchCampaigns(query, {
    limit: 50,
    maxPages: opts.maxPages ?? 3,
  });
  const ctx = await buildScoreContext(device_id);
  const existing = new Map((await listCampaigns()).map((c) => [c.id, c]));

  const ranked = hits.map((h) => scoreCampaign(h, ctx));
  ranked.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.score - a.score;
  });

  // Persist every hit as a campaign (updates budget/rate), keep join state.
  for (const h of hits) {
    const prev = existing.get(h.id) ?? null;
    await upsertCampaign(hitToCampaign(h, prev));
  }

  const topN = Math.min(Math.max(opts.topN ?? 5, 1), 10);
  const rankedOut = ranked.slice(0, topN).map((r) => ({
    id: r.hit.id,
    name: r.hit.name,
    score: Math.round(r.score * 1000) / 1000,
    excluded: r.excluded,
    excludeReason: r.excludeReason,
    rationale: r.rationale,
    rate_per_1k: r.hit.igRatePer1k,
    budget_remaining: Math.round(r.hit.budgetRemaining * 100) / 100,
    requiresApplication: r.hit.requiresApplication,
    joined: ctx.joinedIds.has(r.hit.id),
    video_assets: r.hit.assets.filter((a) => a.isVideo).length,
  }));

  const picked = ranked.find((r) => !r.excluded) ?? null;
  let started_chain_id: string | null = null;
  let brief: StructuredBrief["summary"] | null = null;

  if (picked) {
    const full = await getCampaignFromApi(picked.hit.id).catch(() => picked.hit);
    brief = buildStructuredBrief(full).summary;
    if (!dryRun) {
      const campaign: Campaign | null = (await getCampaign(picked.hit.id)) ?? null;
      if (!campaign) throw new Error("picked campaign vanished from store");
      // The chain's check stage re-extracts requirements from the fresh
      // brief; pre-seed the structured brief so render has assets even if
      // the page parse is thinner.
      const b = buildStructuredBrief(full);
      campaign.requirements = JSON.parse(b.requirements_json).requirements;
      await upsertCampaign(campaign);
      const chain = await startChain(device_id, campaign);
      started_chain_id = chain.id;
      if (device_id) {
        await logActivity(
          device_id,
          "auto_pick",
          `🤖 Auto-pick: ${picked.hit.name} (score ${picked.score.toFixed(3)}) — chain ${chain.id} @ ${chain.stage}`
        );
      }
    }
  }

  const result: AutoDiscoverResult = {
    query,
    hits_seen: totalSeen,
    ranked: rankedOut,
    picked,
    started_chain_id,
    dry_run: dryRun,
    brief,
  };
  if (device_id) await saveAutoDiscoverLog(device_id, result);
  return result;
}
