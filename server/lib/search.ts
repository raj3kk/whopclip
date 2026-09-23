/**
 * Search-driven campaign discovery — the server-side equivalent of the
 * user's in-app flow: open the Content Rewards app, tap search, type a
 * keyword (e.g. "instagram"), and scroll the results.
 *
 * NOTE: the literal query "New Campaigns instagram" returns ZERO results
 * from this API (verified 2026-09-23) — the app's search box treats it as
 * one literal phrase. The meaningful keyword is "instagram". This module
 * runs `search=instagram` (configurable) with cursor pagination, i.e. the
 * same scroll the user would do.
 *
 * Endpoints (public, no login needed):
 *   GET /api/campaign/campaigns?search=<q>&limit=<n>&cursor=<c>
 *       -> { data:[campaign...], pagination:{count,limit,cursor,nextCursor}, success }
 *   GET /api/campaign/campaigns/:id -> { data: campaign, success }
 *
 * The campaign record carries the FULL structured brief:
 *   configuration.budget            (cents)
 *   configuration.payoutModel[]     { platform, rate (cents/1k), minPayout, maxPayout }
 *   configuration.content.guidelines (Content requirements text)
 *   configuration.creator           (Creator requirements)
 *   configuration.requirement       flags: caption, faceOnCamera, linkInBio,
 *                                   linkInBioUrl, brandLogo, noRepostedContent,
 *                                   preApproval, videoLength
 *   configuration.referenceMaterial[] { name, url (bucket-relative or absolute
 *                                   or youtu.be), mediaType, type }
 *   metrics.budgetSpentCents
 */
import { crFetch, absoluteAssetUrl, CR_BASE, WhopError } from "./whop";
import type { Campaign } from "./store";

export interface PayoutModelEntry {
  platform: string;
  ratePer1k: number; // USD per 1k views
  minPayout: number;
  maxPayout: number;
}

export interface ReferenceAsset {
  name: string;
  url: string; // always absolute after parsing
  mediaType: string;
  kind: string;
  isVideo: boolean;
}

export interface SearchHit {
  id: string;
  name: string;
  description: string;
  status: string;
  requiresApplication: boolean;
  private: boolean;
  budgetCents: number;
  budgetSpentCents: number;
  budgetRemaining: number; // USD
  payouts: PayoutModelEntry[];
  igRatePer1k: number; // USD per 1k views on instagram (0 when no IG payout)
  guidelines: string; // Content requirements (structured source)
  creatorRequirements: string; // Creator requirements (structured source)
  requirementFlags: Record<string, unknown>;
  assets: ReferenceAsset[];
  launchDate: string;
  url: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);

function parseHit(c: Record<string, unknown>): SearchHit | null {
  if (typeof c.id !== "string" || !c.id) return null;
  const conf = (c.configuration ?? {}) as Record<string, unknown>;
  const metrics = (c.metrics ?? {}) as Record<string, unknown>;
  const content = (conf.content ?? {}) as Record<string, unknown>;
  const creator = (conf.creator ?? {}) as Record<string, unknown>;
  const flags = (conf.requirement ?? {}) as Record<string, unknown>;
  const payouts: PayoutModelEntry[] = Array.isArray(conf.payoutModel)
    ? (conf.payoutModel as Record<string, unknown>[]).map((p) => ({
        platform: str(p.platform),
        ratePer1k: num(p.rate) / 100,
        minPayout: num(p.minPayout) / 100,
        maxPayout: num(p.maxPayout) / 100,
      }))
    : [];
  const ig = payouts.find((p) => p.platform === "instagram");
  const budgetCents = num(conf.budget);
  const spentCents = num(metrics.budgetSpentCents);
  const assets: ReferenceAsset[] = Array.isArray(conf.referenceMaterial)
    ? (conf.referenceMaterial as Record<string, unknown>[])
        .map((r) => {
          const url = absoluteAssetUrl(str(r.url));
          const mediaType = str(r.mediaType).toLowerCase();
          const name = str(r.name).toLowerCase();
          const isVideo =
            mediaType.includes("video") ||
            mediaType === "mov" ||
            mediaType === "mp4" ||
            /\.(mp4|mov|webm|mkv)(\?|$)/i.test(url) ||
            /youtu\.?be/.test(url);
          return {
            name: str(r.name),
            url,
            mediaType: str(r.mediaType),
            kind: str(r.type),
            isVideo,
          };
        })
        .filter((a) => a.url)
    : [];
  const creatorTypes = Array.isArray(creator.creatorTypes)
    ? (creator.creatorTypes as Record<string, unknown>[])
        .map((t) => str(t.name))
        .filter(Boolean)
        .join(", ")
    : "";
  const creatorDesc = str(creator.description).replace(/<[^>]*>/g, "").trim();
  return {
    id: String(c.id),
    name: str(c.name),
    description: str(c.description),
    status: str(c.status),
    requiresApplication: c.requiresApplication === true,
    private: c.private === true,
    budgetCents,
    budgetSpentCents: spentCents,
    budgetRemaining: Math.max(0, (budgetCents - spentCents) / 100),
    payouts,
    igRatePer1k: ig ? ig.ratePer1k : 0,
    guidelines: str(content.guidelines),
    creatorRequirements: [creatorTypes, creatorDesc].filter(Boolean).join(" — "),
    requirementFlags: flags,
    assets,
    launchDate: str(c.launchDate),
    url: `${CR_BASE}/discover/${c.id}`,
  };
}

/**
 * Run the keyword search with cursor pagination ("scrolling").
 * Returns up to `maxPages * limit` hits. Read-only, no login.
 */
export async function searchCampaigns(
  query: string,
  opts: { limit?: number; maxPages?: number } = {}
): Promise<{ hits: SearchHit[]; totalSeen: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const maxPages = Math.min(Math.max(opts.maxPages ?? 3, 1), 10);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let totalSeen = 0;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      search: query,
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
    const res = await crFetch(`/api/campaign/campaigns?${qs.toString()}`);
    if (res.status !== 200) {
      throw new WhopError(`campaign search returned ${res.status}`, 502);
    }
    let body: {
      data?: Record<string, unknown>[];
      pagination?: { nextCursor?: string | null };
      success?: boolean;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new WhopError("campaign search returned invalid JSON", 502);
    }
    const data = Array.isArray(body.data) ? body.data : [];
    totalSeen += data.length;
    for (const c of data) {
      const hit = parseHit(c);
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        hits.push(hit);
      }
    }
    cursor = body.pagination?.nextCursor ?? null;
    if (!cursor || data.length === 0) break;
  }
  return { hits, totalSeen };
}

/** Full campaign record via the API detail endpoint (read-only, no login). */
export async function getCampaignFromApi(campaignId: string): Promise<SearchHit> {
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) {
    throw new WhopError("invalid campaign id", 400);
  }
  const res = await crFetch(`/api/campaign/campaigns/${campaignId}`);
  if (res.status === 404) throw new WhopError("campaign not found", 404);
  if (res.status !== 200) throw new WhopError(`campaign api returned ${res.status}`, 502);
  let body: { data?: Record<string, unknown>; success?: boolean };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new WhopError("campaign api returned invalid JSON", 502);
  }
  const hit = body.data ? parseHit(body.data) : null;
  if (!hit) throw new WhopError("campaign api returned no usable record", 502);
  return hit;
}

/** Convert an API search hit into the store's Campaign shape (requirements parsed later). */
export function hitToCampaign(h: SearchHit, prev: Campaign | null): Campaign {
  const now = new Date().toISOString();
  return {
    id: prev?.id ?? h.id,
    name: prev?.name ?? h.name,
    whop_url: h.url,
    active: prev?.active ?? h.status === "active",
    budget_remaining: h.budgetRemaining,
    payout_per_1k: h.igRatePer1k || prev?.payout_per_1k || 0,
    joined: prev?.joined ?? false,
    requiresApplication: h.requiresApplication,
    requirements: prev?.requirements ?? null,
    created_at: prev?.created_at ?? now,
    updated_at: now,
  };
}
