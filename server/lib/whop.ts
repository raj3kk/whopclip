/**
 * Server-side Whop Content Rewards client.
 *
 * Runs on Vercel (USA) instead of the phone's WebView. This fixes two
 * standing problems at once:
 *  1. The phone automation is flaky ("galat command", doesn't know what to
 *     do) — deterministic server code replaces WebView scripting for all
 *     Whop-side work (discover / check / join / submit).
 *  2. Region blocks — India IPs are rejected on some campaign pages; all
 *     requests here originate from Vercel's servers.
 *
 * Auth model (user-approved): the phone uploads its logged-in Whop/Instagram
 * cookies via POST /api/sessions (AES-256-GCM encrypted at rest). This
 * module decrypts them IN MEMORY ONLY and uses them as a Cookie header.
 * Cookies are NEVER logged, NEVER returned to any client, NEVER persisted.
 *
 * Reverse-engineered 2026-09-23 from contentrewards.com's own JS:
 *  - Discover list + campaign detail are SSR pages with the data embedded
 *    in React Flight payloads -> plain GET, no login needed.
 *  - API base is relative: /api/<service> on contentrewards.com
 *    (module 901751: apiBase = t => `/api/${t}`).
 *  - Join:  POST /api/campaign/campaigns/:id/apply          {json}
 *  - Submit: POST /api/submission/submissions                {json}
 *  - Join URL: GET /api/campaign/campaigns/discover/:id/join-url
 */
import { decryptSession } from "./crypto";
import { getSession, type Campaign } from "./store";
import { extractRequirementsFromText } from "./requirements";
import { getCampaignFromApi, hitToCampaign } from "./search";

export const CR_BASE = "https://contentrewards.com";
/** Public S3 bucket where campaign reference assets are hosted (seen on
 *  campaign pages; the API returns paths relative to this base). */
export const CR_ASSET_BASE =
  "https://content-rewards-production-publicassetsbucket-oxvzxvnr.s3.us-east-1.amazonaws.com/";

/** Resolve a referenceMaterial url (absolute, youtu.be, or bucket-relative). */
export function absoluteAssetUrl(u: string): string {
  const t = (u || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  return CR_ASSET_BASE + t.replace(/^\/+/, "");
}
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 25000;

export class WhopError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/** Decrypt the saved Whop session and build a Cookie header. In-memory only. */
export async function whopCookieHeader(device_id: string): Promise<string> {
  const s = await getSession(device_id, "whop");
  if (!s) throw new WhopError("no whop session saved for this device (re-login in app)", 409);
  let cookies: Record<string, string>;
  try {
    cookies = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
  } catch {
    throw new WhopError("whop session decrypt failed", 500);
  }
  const header = Object.entries(cookies)
    .filter(([k, v]) => k && v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (!header) throw new WhopError("whop session has no cookies", 409);
  return header;
}

/** Shared fetch helper for contentrewards.com (cookies NEVER logged). */
export async function crFetch(
  path: string,
  opts: {
    method?: string;
    cookieHeader?: string;
    json?: unknown;
    referer?: string;
    bearer?: string;
  } = {}
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (opts.cookieHeader) {
      // NEVER log this header — it carries the user's login cookies.
      headers["Cookie"] = opts.cookieHeader;
    }
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Accept"] = "application/json, text/plain, */*";
      headers["Origin"] = CR_BASE;
    }
    if (opts.referer) headers["Referer"] = opts.referer;
    if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
    const res = await fetch(CR_BASE + path, {
      method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
      headers,
      redirect: "manual",
      signal: ctrl.signal,
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** Decode React Flight push payloads: self.__next_f.push([1,"..."]) */
function flightData(html: string): string {
  const out: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      // The capture is a JS string literal body — JSON string syntax matches.
      out.push(JSON.parse(`"${m[1]}"`));
    } catch {
      // Skip malformed chunks; other pushes usually carry the data.
    }
  }
  return out.join("");
}

/** Brace-match a JSON value (object or array) starting at index `i`. */
function braceMatch(s: string, i: number): string | null {
  const open = s[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0;
  let instr = false;
  let esc = false;
  for (let p = i; p < s.length; p++) {
    const c = s[p];
    if (instr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') instr = false;
    } else {
      if (c === '"') instr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return s.slice(i, p + 1);
      }
    }
  }
  return null;
}

export interface DiscoverCard {
  id: string;
  brand: string;
  title: string;
  description: string;
  availableBudget: number;
  totalBudget: number;
  ratePer1kLabel: string;
  payoutSortRaw: number;
  platforms: string[];
  requiresApplication: boolean;
  creatorCount: number;
  submissionCount: number;
  isVerified: boolean;
  url: string;
}

/** Server-side discover: GET /discover, parse embedded campaign cards. No login needed. */
export async function discoverCampaigns(): Promise<DiscoverCard[]> {
  const res = await crFetch("/discover");
  if (res.status !== 200) {
    throw new WhopError(`discover page returned ${res.status}`, 502);
  }
  const html = await res.text();
  const data = flightData(html);
  const key = '"campaigns":';
  const ki = data.indexOf(key);
  if (ki < 0) throw new WhopError("discover payload has no campaigns array", 502);
  const bi = data.indexOf("[", ki + key.length);
  const raw = braceMatch(data, bi);
  if (!raw) throw new WhopError("could not parse campaigns array", 502);
  let arr: Record<string, unknown>[];
  try {
    arr = JSON.parse(raw.replaceAll('"$undefined"', "null")) as Record<string, unknown>[];
  } catch {
    throw new WhopError("campaigns array is not valid JSON", 502);
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
  return arr
    .filter((c) => typeof c.id === "string" && c.id)
    .map((c) => ({
      id: String(c.id),
      brand: str(c.brand),
      title: str(c.title) || str(c.brand),
      description: str(c.description),
      availableBudget: num(c.availableBudgetRaw),
      totalBudget: num(c.budgetTotalRaw),
      ratePer1kLabel: str(c.ratePer1kLabel),
      payoutSortRaw: num(c.payoutSortRaw),
      platforms: Array.isArray(c.platforms) ? c.platforms.filter((p) => typeof p === "string") : [],
      requiresApplication: c.requiresApplication === true,
      creatorCount: num(c.creatorCountRaw),
      submissionCount: num(c.submissionCountRaw),
      isVerified: c.isVerified === true,
      url: `${CR_BASE}/discover/${c.id}`,
    }));
}

export interface CampaignDetail {
  id: string;
  name: string;
  brand: string;
  description: string;
  status: string;
  budgetCents: number;
  budgetSpentCents: number;
  budgetRemaining: number;
  payoutType: string;
  payouts: Array<{
    platform: string;
    rateCents: number;
    minPayoutCents: number;
    maxPayoutCents: number;
  }>;
  primaryPayoutCents: number;
  platforms: string[];
  contentRequirements: string[];
  referenceMaterials: Array<{ url: string; type: string }>;
  requiresApplication: boolean;
  url: string;
  raw: Record<string, unknown>;
}

/**
 * Server-side campaign detail: GET /discover/:id, parse the embedded
 * campaign object (full brief, payouts, requirements). No login needed.
 */
export async function getCampaignDetail(campaignId: string): Promise<CampaignDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) {
    throw new WhopError("invalid campaign id", 400);
  }
  const res = await crFetch(`/discover/${campaignId}`);
  if (res.status === 404) throw new WhopError("campaign not found", 404);
  if (res.status !== 200) throw new WhopError(`campaign page returned ${res.status}`, 502);
  const html = await res.text();
  const data = flightData(html);
  const marker = `"id":"${campaignId}"`;
  const mi = data.indexOf(marker);
  if (mi < 0) throw new WhopError("campaign object not embedded in page", 502);
  // Walk back to the enclosing object's opening brace.
  let depth = 0;
  let start = -1;
  for (let p = mi; p >= 0; p--) {
    const c = data[p];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        start = p;
        break;
      }
      depth--;
    }
  }
  if (start < 0) throw new WhopError("could not locate campaign object", 502);
  const raw = braceMatch(data, start);
  if (!raw) throw new WhopError("could not parse campaign object", 502);
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new WhopError("campaign object is not valid JSON", 502);
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
  const budgetCents = num(o.budgetCents);
  const spent = num((o.metrics as Record<string, unknown> | undefined)?.budgetSpentCents);
  const payouts = Array.isArray(o.payouts)
    ? (o.payouts as Record<string, unknown>[]).map((p) => ({
        platform: str(p.platform),
        rateCents: num(p.rateCents),
        minPayoutCents: num(p.minPayoutCents),
        maxPayoutCents: num(p.maxPayoutCents),
      }))
    : [];
  const cr = o.contentRequirements as Record<string, unknown> | undefined;
  const items = cr && Array.isArray(cr.items) ? cr.items.filter((x) => typeof x === "string") : [];
  const refs = Array.isArray(o.referenceMaterials)
    ? (o.referenceMaterials as Record<string, unknown>[])
        .filter((r) => typeof r.url === "string")
        .map((r) => ({ url: String(r.url), type: str(r.type) }))
    : [];
  return {
    id: String(o.id ?? campaignId),
    name: str(o.name),
    brand: str(o.organizationName),
    description: str(o.description),
    status: str(o.status),
    budgetCents,
    budgetSpentCents: spent,
    budgetRemaining: Math.max(0, (budgetCents - spent) / 100),
    payoutType: str(o.payoutType),
    payouts,
    primaryPayoutCents: num(o.primaryPayoutCents),
    platforms: Array.isArray(o.platforms) ? (o.platforms as unknown[]).filter((p): p is string => typeof p === "string") : [],
    contentRequirements: items,
    referenceMaterials: refs,
    requiresApplication: o.requiresApplication === true,
    url: `${CR_BASE}/discover/${campaignId}`,
    raw: o,
  };
}

/** Convert a server-fetched detail object into the store's Campaign shape. */
export function detailToCampaign(d: CampaignDetail, prev: Campaign | null): Campaign {
  const now = new Date().toISOString();
  const ig = d.payouts.find((p) => p.platform === "instagram") ?? d.payouts[0];
  const rate = ig ? ig.rateCents / 100 : d.primaryPayoutCents / 100;
  const briefText = [d.description, ...d.contentRequirements].join("\n\n");
  const extraction = extractRequirementsFromText(briefText);
  return {
    id: prev?.id ?? d.id,
    name: prev?.name ?? d.name,
    whop_url: d.url,
    active: prev?.active ?? d.status === "active",
    budget_remaining: d.budgetRemaining,
    payout_per_1k: rate || prev?.payout_per_1k || 0,
    joined: prev?.joined ?? false,
    requiresApplication: d.requiresApplication,
    requirements: extraction.complete ? extraction.requirements : prev?.requirements ?? null,
    created_at: prev?.created_at ?? now,
    updated_at: now,
  };
}

/** Convert a discover card into the store's Campaign shape (requirements filled later). */
export function cardToCampaign(c: DiscoverCard, prev: Campaign | null): Campaign {
  const now = new Date().toISOString();
  const rateMatch = c.ratePer1kLabel.match(/[\d.]+/);
  return {
    id: prev?.id ?? c.id,
    name: prev?.name ?? (c.title || c.brand),
    whop_url: c.url,
    active: prev?.active ?? true,
    budget_remaining: c.availableBudget,
    payout_per_1k: (rateMatch ? parseFloat(rateMatch[0]) : c.payoutSortRaw) || prev?.payout_per_1k || 0,
    joined: prev?.joined ?? false,
    requiresApplication: c.requiresApplication,
    requirements: prev?.requirements ?? null,
    created_at: prev?.created_at ?? now,
    updated_at: now,
  };
}

/** Re-parse an API search hit as a CampaignDetail (structured brief source). */
export async function getApiDetail(campaignId: string) {
  return getCampaignFromApi(campaignId);
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

async function authedApi<T>(
  device_id: string,
  method: "GET" | "POST",
  apiPath: string,
  json?: unknown
): Promise<ApiResult<T>> {
  const cookieHeader = await whopCookieHeader(device_id);
  // Content Rewards API may want the access token as a Bearer header
  // instead of (or in addition to) cookies. Extract it from the cookie jar.
  let bearer: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "whop-core.access-token") {
      bearer = rest.join("=").trim();
      break;
    }
  }
  let res: Response;
  try {
    res = await crFetch(apiPath, {
      method,
      cookieHeader,
      json,
      referer: `${CR_BASE}/discover`,
      bearer: bearer ?? undefined,
    });
  } catch (e) {
    throw new WhopError(`whop api unreachable: ${e instanceof Error ? e.message : "network error"}`, 502);
  }
  const text = await res.text().catch(() => "");
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    // Non-JSON (e.g. login HTML) — treat by status code below.
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, data, error: `whop session rejected (re-login in app) [${text.slice(0, 180)}]` };
  }
  if (res.status >= 400) {
    const msg =
      (data as Record<string, unknown> | null)?.error ??
      (data as Record<string, unknown> | null)?.message ??
      text.slice(0, 200);
    return { ok: false, status: res.status, data, error: `whop api ${res.status}: ${String(msg).slice(0, 300)}` };
  }
  return { ok: true, status: res.status, data, error: null };
}

/**
 * Join state probe: fetch the campaign page WITH the user's cookies and look
 * for application/join markers in the embedded data.
 * Returns joined=true/false, or null when the page gives no clear signal
 * (fail-closed: caller must not assume).
 */
export async function probeJoinState(
  device_id: string,
  campaignId: string
): Promise<{ joined: boolean | null; detail: string }> {
  const cookieHeader = await whopCookieHeader(device_id);
  const res = await crFetch(`/discover/${campaignId}`, { cookieHeader });
  if (res.status !== 200) {
    return { joined: null, detail: `campaign page returned ${res.status}` };
  }
  const data = flightData(await res.text()).toLowerCase();
  const joinedMarkers = [
    '"isapplied":true',
    '"applied":true',
    '"hasapplied":true',
    '"isjoined":true',
    '"status":"applied"',
    '"applicationstatus":"approved"',
    "you're in",
    "you are in",
  ];
  const notJoinedMarkers = ['"isapplied":false', '"applied":false', '"hasapplied":false'];
  if (joinedMarkers.some((m) => data.includes(m))) {
    return { joined: true, detail: "page embeds an applied/joined marker" };
  }
  if (notJoinedMarkers.some((m) => data.includes(m))) {
    return { joined: false, detail: "page embeds a not-applied marker" };
  }
  // Fallback: the join CTA. If the page still offers "join"/"apply now"
  // prominently, the user hasn't joined; if it shows "submit content" or
  // dashboard links instead, treat as ambiguous.
  const hasJoinCta = /join this campaign|apply now|join campaign/.test(data);
  const hasSubmitCta = /submit content|your submissions|view dashboard/.test(data);
  if (hasJoinCta && !hasSubmitCta) return { joined: false, detail: "page shows a join CTA" };
  if (hasSubmitCta && !hasJoinCta) return { joined: true, detail: "page shows submit/dashboard CTA" };
  return { joined: null, detail: "no clear join marker on authed page" };
}

/** Join (apply to) a campaign: POST /api/campaign/campaigns/:id/apply */
export async function applyToCampaign(
  device_id: string,
  campaignId: string,
  body: Record<string, unknown> = {}
): Promise<ApiResult> {
  return authedApi(device_id, "POST", `/api/campaign/campaigns/${campaignId}/apply`, body);
}

/** Add social accounts after applying: POST /api/campaign/campaigns/:id/apply/accounts */
export async function addApplicationAccounts(
  device_id: string,
  campaignId: string,
  accounts: unknown
): Promise<ApiResult> {
  return authedApi(device_id, "POST", `/api/campaign/campaigns/${campaignId}/apply/accounts`, accounts);
}

/** Resolve the platform's join URL (may point at a whop.com experience). */
export async function getJoinUrl(device_id: string, campaignId: string): Promise<ApiResult> {
  return authedApi(device_id, "GET", `/api/campaign/campaigns/discover/${campaignId}/join-url`);
}

export interface SubmissionBody {
  campaignId: string;
  platform: string;
  url: string;
  [k: string]: unknown;
}

/** Submit a posted clip: POST /api/submission/submissions */
export async function createSubmission(
  device_id: string,
  body: SubmissionBody
): Promise<ApiResult> {
  return authedApi(device_id, "POST", "/api/submission/submissions", body);
}

/** List my applications (join state across campaigns). Best-effort. */
export async function listMyApplications(device_id: string): Promise<ApiResult> {
  return authedApi(device_id, "GET", "/api/campaign/campaigns/applications/me");
}
