/**
 * WhopClip control-plane state.
 *
 * Storage: Supabase `flipify_kv` (namespaced `whopclip:*`) when
 * SUPABASE_SERVICE_ROLE_KEY is set; otherwise a process-local in-memory
 * store (dev / pre-provisioned mode — state does not survive cold starts).
 *
 * All functions are async. Key layout:
 *   session:{device_id}:{service}   Session
 *   campaign:{id}                   Campaign
 *   campaigns                       string[] (index of campaign ids)
 *   job:{id}                        Job
 *   queue:{device_id}               string[] (job ids, enqueue order)
 *   submission:{id}                 Submission
 *   submissions:{device_id}         string[] (submission ids)
 */

import { dbEnabled, supabaseKV, type KVBackend } from "./db";
import crypto from "crypto";

export type ServiceName = "whop" | "instagram";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type SubmissionStatus = "submitted" | "pending" | "approved" | "rejected";

export interface Session {
  device_id: string;
  service: ServiceName;
  encrypted: string; // AES-256-GCM blob (JSON string)
  user_agent: string;
  device_model: string;
  stale: boolean;
  created_at: string;
  updated_at: string;
}

export interface Requirements {
  video_max_duration_s: number | null;
  aspect: "9:16";
  captions_required: boolean;
  caption_template: string | null;
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
  requirements: Requirements | null;
  created_at: string;
  updated_at: string;
}

export interface JobStep { [k: string]: unknown }

export interface Job {
  id: string;
  device_id: string;
  type: string;
  status: JobStatus;
  steps: JobStep[];
  result: unknown;
  created_at: string;
  updated_at: string;
}

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

/* ---------------- backend ---------------- */

class MemoryKV implements KVBackend {
  private m = new Map<string, { value: unknown; updated_at: string }>();
  async get(key: string) {
    return this.m.get(key)?.value ?? null;
  }
  async set(key: string, value: unknown) {
    this.m.set(key, { value, updated_at: new Date().toISOString() });
  }
  async cas(key: string, value: unknown, updatedAt: string) {
    const cur = this.m.get(key);
    if (!cur || cur.updated_at !== updatedAt) return false;
    this.m.set(key, { value, updated_at: new Date().toISOString() });
    return true;
  }
  /** used only for atomic claim: fetch raw row with updated_at */
  async getRow(key: string) {
    return this.m.get(key) ?? null;
  }
}

const mem = new MemoryKV();
const kv: KVBackend = dbEnabled ? supabaseKV : mem;
if (!dbEnabled) {
  console.warn("[whopclip] SUPABASE_SERVICE_ROLE_KEY not set — using ephemeral in-memory store");
}

/** Fetch a value plus its updated_at (for CAS). */
async function getWithTs(key: string): Promise<{ value: unknown; updated_at: string } | null> {
  if (!dbEnabled) return mem.getRow(key);
  const full = `whopclip:${key}`;
  const base = process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const res = await fetch(
    `${base}/rest/v1/flipify_kv?device_id=eq.whopclip&key=eq.${encodeURIComponent(full)}&select=value,updated_at`,
    { headers: { apikey: k, Authorization: `Bearer ${k}` } }
  );
  if (!res.ok) return null;
  const arr = (await res.json()) as Array<{ value: unknown; updated_at: string }>;
  if (!arr.length) return null;
  return { value: arr[0].value, updated_at: arr[0].updated_at };
}

async function getIdx(key: string): Promise<string[]> {
  const v = await kv.get(key);
  return Array.isArray(v) ? (v as string[]) : [];
}
async function addToIdx(key: string, id: string) {
  const idx = await getIdx(key);
  if (!idx.includes(id)) {
    idx.push(id);
    await kv.set(key, idx);
  }
}

/* ---------------- sessions ---------------- */

const sessionKey = (device_id: string, service: ServiceName) =>
  `session:${device_id}:${service}`;

export async function saveSession(s: Session): Promise<void> {
  await kv.set(sessionKey(s.device_id, s.service), s);
}

export async function getSession(
  device_id: string,
  service: ServiceName
): Promise<Session | null> {
  const v = await kv.get(sessionKey(device_id, service));
  return (v as Session) ?? null;
}

export async function markSessionStale(device_id: string, service: ServiceName): Promise<void> {
  const s = await getSession(device_id, service);
  if (!s) return;
  s.stale = true;
  s.updated_at = new Date().toISOString();
  await kv.set(sessionKey(device_id, service), s);
}

export async function sessionStatus(device_id: string): Promise<
  Record<ServiceName, { linked: boolean; stale: boolean }>
> {
  const out = {} as Record<ServiceName, { linked: boolean; stale: boolean }>;
  for (const svc of ["whop", "instagram"] as ServiceName[]) {
    const s = await getSession(device_id, svc);
    out[svc] = { linked: !!s, stale: s?.stale === true };
  }
  return out;
}

/* ---------------- campaigns ---------------- */

export function parseRequirements(raw: unknown): Requirements {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  // duration: "30s"/"60 seconds"/45 -> seconds (default: no cap)
  let dur: number | null = null;
  const d = r.video_max_duration_s ?? r.duration ?? r.max_duration;
  if (typeof d === "number" && d > 0) dur = d;
  else if (typeof d === "string") {
    const m = d.match(/(\d+(?:\.\d+)?)/);
    if (m) dur = parseFloat(m[1]);
  }
  const payout =
    typeof r.payout_per_1k === "number"
      ? r.payout_per_1k
      : parseFloat(str(r.payout_per_1k)) || 0;
  return {
    video_max_duration_s: dur,
    aspect: "9:16", // always forced
    captions_required: r.captions_required !== false,
    caption_template: str(r.caption_template) || null,
    required_mentions: list(r.required_mentions ?? r.mentions),
    required_hashtags: list(r.required_hashtags ?? r.hashtags),
    posting_rules: list(r.posting_rules ?? r.rules),
    payout_per_1k: payout,
  };
}

export async function upsertCampaign(c: Campaign): Promise<void> {
  await kv.set(`campaign:${c.id}`, c);
  await addToIdx("campaigns", c.id);
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const v = await kv.get(`campaign:${id}`);
  return (v as Campaign) ?? null;
}

export async function listCampaigns(): Promise<Campaign[]> {
  const ids = await getIdx("campaigns");
  const out: Campaign[] = [];
  for (const id of ids) {
    const c = await getCampaign(id);
    if (c) out.push(c);
  }
  return out;
}

/** Checkpoint 1 — eligible = active + budget>0 + not already submitted by this device. */
export async function alreadySubmitted(
  device_id: string,
  campaign_id: string
): Promise<boolean> {
  const ids = await getIdx(`submissions:${device_id}`);
  for (const id of ids) {
    const s = (await kv.get(`submission:${id}`)) as Submission | null;
    if (s && s.campaign_id === campaign_id) return true;
  }
  return false;
}

export async function selectCampaign(device_id: string): Promise<Campaign | null> {
  const campaigns = await listCampaigns();
  const eligible: Campaign[] = [];
  for (const c of campaigns) {
    if (!c.active || c.budget_remaining <= 0) continue;
    if (await alreadySubmitted(device_id, c.id)) continue;
    eligible.push(c);
  }
  eligible.sort((a, b) => {
    if (a.joined !== b.joined) return a.joined ? -1 : 1;
    return b.payout_per_1k - a.payout_per_1k;
  });
  return eligible[0] ?? null;
}

/* ---------------- jobs ---------------- */

export async function enqueueJob(job: Job): Promise<void> {
  await kv.set(`job:${job.id}`, job);
  await addToIdx(`queue:${job.device_id}`, job.id);
}

export async function getJob(id: string): Promise<Job | null> {
  const v = await kv.get(`job:${id}`);
  return (v as Job) ?? null;
}

/**
 * Claim the oldest queued job for a device, atomically (CAS on updated_at)
 * so two pollers can never run the same job.
 */
export async function claimJob(device_id: string): Promise<Job | null> {
  const ids = await getIdx(`queue:${device_id}`);
  for (const id of ids) {
    const row = await getWithTs(`job:${id}`);
    if (!row) continue;
    const job = row.value as Job | null;
    if (!job || job.status !== "queued") continue;
    const claimed: Job = {
      ...job,
      status: "running",
      updated_at: new Date().toISOString(),
    };
    const ok = dbEnabled
      ? await supabaseKV.cas(`job:${id}`, claimed, row.updated_at)
      : await mem.cas(`job:${id}`, claimed, row.updated_at);
    if (ok) return claimed;
    // lost the race — try next
  }
  return null;
}

export async function requeueJob(id: string): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  job.status = "queued";
  job.updated_at = new Date().toISOString();
  await kv.set(`job:${id}`, job);
  return job;
}

export async function finishJob(
  id: string,
  status: JobStatus,
  result: unknown
): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  job.status = status;
  job.result = result;
  job.updated_at = new Date().toISOString();
  await kv.set(`job:${id}`, job);
  return job;
}

export async function listJobs(device_id: string): Promise<Job[]> {
  const ids = await getIdx(`queue:${device_id}`);
  const out: Job[] = [];
  for (const id of ids) {
    const j = await getJob(id);
    if (j) out.push(j);
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/* ---------------- submissions & earnings ---------------- */

export async function recordSubmission(s: Submission): Promise<void> {
  await kv.set(`submission:${s.id}`, s);
  await addToIdx(`submissions:${s.device_id}`, s.id);
}

export async function updateSubmissionViews(
  id: string,
  views: number,
  earned_usd: number
): Promise<void> {
  const v = (await kv.get(`submission:${id}`)) as Submission | null;
  if (!v) return;
  v.views = views;
  v.earned_usd = earned_usd;
  await kv.set(`submission:${id}`, v);
}

export async function earningsSummary(device_id: string): Promise<{
  submissions: Submission[];
  total_earned_usd: number;
  pending_count: number;
}> {
  const ids = await getIdx(`submissions:${device_id}`);
  const submissions: Submission[] = [];
  for (const id of ids) {
    const s = (await kv.get(`submission:${id}`)) as Submission | null;
    if (s) submissions.push(s);
  }
  return {
    submissions,
    total_earned_usd: submissions.reduce((t, s) => t + (s.earned_usd ?? 0), 0),
    pending_count: submissions.filter(
      (s) => s.status === "submitted" || s.status === "pending"
    ).length,
  };
}

/* ---------------- device pairing ---------------- */

export interface PairCode {
  code: string;
  created_at: string;
  expires_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generatePairCode(): string {
  // 8 Crockford chars, shown as XXXX-XXXX (no ambiguous I/L/O/U)
  let s = "";
  const buf = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += CROCKFORD[buf[i] % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function createPairCode(ttlMinutes = 10): Promise<PairCode> {
  const now = new Date();
  const p: PairCode = {
    code: generatePairCode(),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMinutes * 60000).toISOString(),
    claimed_by: null,
    claimed_at: null,
  };
  await kv.set(`pair:${p.code}`, p);
  return p;
}

export async function getPairCode(code: string): Promise<PairCode | null> {
  const v = await kv.get(`pair:${code.toUpperCase()}`);
  return (v as PairCode) ?? null;
}

export async function claimPairCode(
  code: string,
  device_id: string
): Promise<PairCode | null> {
  const p = await getPairCode(code);
  if (!p) return null;
  if (p.claimed_by) return p; // already claimed — idempotent
  if (new Date(p.expires_at).getTime() < Date.now()) return null;
  p.claimed_by = device_id;
  p.claimed_at = new Date().toISOString();
  await kv.set(`pair:${p.code}`, p);
  return p;
}

/* ---------------- linked devices ---------------- */

export interface Device {
  device_id: string;
  paired_at: string;
  last_poll_at: string | null;
  app_version: string | null;
  device_model: string | null;
}

export async function registerDevice(d: Device): Promise<void> {
  const existing = await getDevice(d.device_id);
  await kv.set(`device:${d.device_id}`, { ...existing, ...d, device_id: d.device_id });
  await addToIdx("devices", d.device_id);
}

export async function getDevice(device_id: string): Promise<Device | null> {
  const v = await kv.get(`device:${device_id}`);
  return (v as Device) ?? null;
}

export async function listDevices(): Promise<Device[]> {
  const ids = await getIdx("devices");
  const out: Device[] = [];
  for (const id of ids) {
    const d = await getDevice(id);
    if (d) out.push(d);
  }
  return out.sort((a, b) => (a.paired_at < b.paired_at ? 1 : -1));
}

/** Update last-poll heartbeat (and optional fields) for a device. */
export async function touchDevice(
  device_id: string,
  patch: Partial<Pick<Device, "app_version" | "device_model">> = {}
): Promise<void> {
  if (!device_id) return;
  const existing = await getDevice(device_id);
  const now = new Date().toISOString();
  if (existing) {
    await kv.set(`device:${device_id}`, {
      ...existing,
      ...patch,
      last_poll_at: now,
    });
  } else {
    // auto-register unknown pollers (phone installed before pairing UI existed)
    await registerDevice({
      device_id,
      paired_at: now,
      last_poll_at: now,
      app_version: patch.app_version ?? null,
      device_model: patch.device_model ?? null,
    });
  }
}

/** Online = polled within the last 5 minutes. */
export function deviceOnline(d: Device): boolean {
  if (!d.last_poll_at) return false;
  return Date.now() - new Date(d.last_poll_at).getTime() < 5 * 60 * 1000;
}

/* ---------------- automation schedule ---------------- */

export interface Schedule {
  device_id: string;
  enabled: boolean;
  /** daily run time "HH:MM" in the device timezone */
  time: string;
  timezone: string;
  last_run_date: string | null; // YYYY-MM-DD
  updated_at: string;
}

const DEFAULT_SCHEDULE = { enabled: false, time: "09:00", timezone: "Asia/Calcutta" };

export async function getSchedule(device_id: string): Promise<Schedule> {
  const v = (await kv.get(`schedule:${device_id}`)) as Schedule | null;
  if (v) return v;
  return {
    device_id,
    ...DEFAULT_SCHEDULE,
    last_run_date: null,
    updated_at: new Date().toISOString(),
  };
}

export async function setSchedule(s: Omit<Schedule, "updated_at">): Promise<Schedule> {
  const full: Schedule = { ...s, updated_at: new Date().toISOString() };
  await kv.set(`schedule:${s.device_id}`, full);
  return full;
}

/** Is a scheduled run due right now? (enabled + time passed today + not run today) */
export function scheduleDue(s: Schedule, now = new Date()): boolean {
  if (!s.enabled) return false;
  const today = now.toISOString().slice(0, 10);
  if (s.last_run_date === today) return false;
  const [h, m] = s.time.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return false;
  // compare in the schedule's timezone via Intl
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: s.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  return hh * 60 + mm >= h * 60 + m;
}

export async function markScheduleRun(device_id: string): Promise<void> {
  const s = await getSchedule(device_id);
  s.last_run_date = new Date().toISOString().slice(0, 10);
  await setSchedule(s);
}
