/**
 * Minimal in-memory store for v1 skeleton.
 * PRODUCTION NOTE: replace with a real DB (Vercel KV / Postgres) —
 * serverless instances do not share memory, so jobs/sessions would be
 * lost between invocations on Vercel. This is scaffolding only.
 */

export type ServiceName = "whop" | "instagram";

export interface DeviceSession {
  device_id: string;
  service: ServiceName;
  /** AES-256-GCM encrypted JSON of cookies */
  encrypted: string;
  user_agent: string;
  device_model: string;
  /** true when the phone reported this session expired -> user must re-login */
  stale: boolean;
  created_at: string;
  updated_at: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  device_id: string;
  type: "ig_post" | "whop_submit" | "whop_check_join" | "whop_join" | "custom";
  status: JobStatus;
  steps: unknown[];
  result: unknown | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignRequirements {
  video_max_duration_s: number;
  aspect: "9:16";
  captions_required: boolean;
  caption_template: string;
  required_mentions: string[];
  required_hashtags: string[];
  posting_rules: string[];
  payout_per_1k: number;
}

export interface Campaign {
  id: string;
  name: string;
  whop_url: string;
  active: boolean;
  budget_remaining: number;
  payout_per_1k: number;
  joined: boolean;
  requirements: CampaignRequirements | null;
  created_at: string;
  updated_at: string;
}

export type SubmissionStatus = "submitted" | "pending" | "approved" | "rejected";

export interface Submission {
  id: string;
  device_id: string;
  campaign_id: string;
  campaign_name: string;
  ig_post_url: string;
  status: SubmissionStatus;
  payout_per_1k: number;
  views: number | null;
  earned_usd: number | null;
  created_at: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __whopclip_store:
    | {
        sessions: Map<string, DeviceSession>;
        jobs: Map<string, Job>;
        campaigns: Map<string, Campaign>;
        submissions: Map<string, Submission>;
      }
    | undefined;
}

function store() {
  if (!global.__whopclip_store) {
    global.__whopclip_store = {
      sessions: new Map(),
      jobs: new Map(),
      campaigns: new Map(),
      submissions: new Map(),
    };
  }
  return global.__whopclip_store;
}

/* ---------------- sessions ---------------- */

export function saveSession(s: DeviceSession) {
  store().sessions.set(`${s.device_id}:${s.service}`, s);
}

export function getSession(device_id: string, service: ServiceName) {
  return store().sessions.get(`${device_id}:${service}`) ?? null;
}

export function markSessionStale(device_id: string, service: ServiceName) {
  const s = getSession(device_id, service);
  if (s) {
    s.stale = true;
    s.updated_at = new Date().toISOString();
  }
  return s;
}

export function sessionStatus(device_id: string) {
  const out: Record<ServiceName, { linked: boolean; stale: boolean }> = {
    whop: { linked: false, stale: false },
    instagram: { linked: false, stale: false },
  };
  for (const svc of ["whop", "instagram"] as ServiceName[]) {
    const s = getSession(device_id, svc);
    if (s) {
      out[svc] = { linked: true, stale: s.stale };
    }
  }
  return out;
}

/* ---------------- jobs ---------------- */

export function enqueueJob(job: Job) {
  store().jobs.set(job.id, job);
}

export function claimJob(device_id: string): Job | null {
  for (const job of store().jobs.values()) {
    if (job.device_id === device_id && job.status === "queued") {
      job.status = "running";
      job.updated_at = new Date().toISOString();
      return job;
    }
  }
  return null;
}

export function finishJob(id: string, status: JobStatus, result: unknown) {
  const job = store().jobs.get(id);
  if (!job) return null;
  job.status = status;
  job.result = result;
  job.updated_at = new Date().toISOString();
  return job;
}

/** Put a running job back to queued (e.g. needs foreground upload). */
export function requeueJob(id: string) {
  const job = store().jobs.get(id);
  if (!job) return null;
  job.status = "queued";
  job.updated_at = new Date().toISOString();
  return job;
}

export function listJobs(device_id: string): Job[] {
  return [...store().jobs.values()].filter((j) => j.device_id === device_id);
}

/* ---------------- campaigns ---------------- */

export function upsertCampaign(c: Campaign) {
  store().campaigns.set(c.id, c);
}

export function getCampaign(id: string) {
  return store().campaigns.get(id) ?? null;
}

export function listCampaigns(): Campaign[] {
  return [...store().campaigns.values()];
}

/**
 * Checkpoint 1 — campaign select.
 * Eligible = active + budget remaining + NOT already submitted by this device.
 * Prefers already-joined, then highest payout per 1k views.
 */
export function selectCampaign(device_id: string): Campaign | null {
  const eligible = listCampaigns().filter(
    (c) => c.active && c.budget_remaining > 0 && !alreadySubmitted(device_id, c.id)
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.joined !== b.joined) return a.joined ? -1 : 1;
    return b.payout_per_1k - a.payout_per_1k;
  });
  return eligible[0];
}

/**
 * Checkpoint 3 — requirements parsing. Defensive: fills defaults so a
 * malformed page can never produce a wrong-spec edit/post.
 */
export function parseRequirements(raw: unknown): CampaignRequirements {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  return {
    video_max_duration_s: num(r.video_max_duration_s, 60),
    aspect: "9:16",
    captions_required: r.captions_required !== false,
    caption_template: str(r.caption_template, ""),
    required_mentions: arr(r.required_mentions),
    required_hashtags: arr(r.required_hashtags),
    posting_rules: arr(r.posting_rules),
    payout_per_1k: num(r.payout_per_1k, 0),
  };
}

/* ---------------- submissions / earnings ---------------- */

export function recordSubmission(s: Submission) {
  store().submissions.set(s.id, s);
}

/** Checkpoint 1 — duplicate-submit prevention. */
export function alreadySubmitted(device_id: string, campaign_id: string): boolean {
  for (const s of store().submissions.values()) {
    if (s.device_id === device_id && s.campaign_id === campaign_id) return true;
  }
  return false;
}

export function listSubmissions(device_id: string): Submission[] {
  return [...store().submissions.values()].filter((s) => s.device_id === device_id);
}

export function earningsSummary(device_id: string) {
  const subs = listSubmissions(device_id);
  const total = subs.reduce((acc, s) => acc + (s.earned_usd ?? 0), 0);
  return {
    submissions: subs,
    total_earned_usd: Math.round(total * 100) / 100,
    pending_count: subs.filter((s) => s.status === "submitted" || s.status === "pending").length,
  };
}
