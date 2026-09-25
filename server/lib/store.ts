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
 *   device_token:{device_id}        { fcm_token, updated_at } (FCM wake push)
 *   submission:{id}                 Submission
 *   submissions:{device_id}         string[] (submission ids)
 */

import {
  dbEnabled,
  nextVersion,
  supabaseKV,
  dualKV,
  kvReadSource,
  kvWriteMode,
  type KVBackend,
  type KVBackendEx,
} from "./db";
import { tursoKV, tursoEnabled, tursoGetWithTs } from "./turso";
import { sendPush } from "./fcm";
import crypto from "crypto";

export type ServiceName = "whop" | "instagram";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type SubmissionStatus = "submitted" | "pending" | "approved" | "rejected";

export interface Session {
  device_id: string;
  service: ServiceName;
  encrypted: string; // AES-256-GCM blob (JSON string)
  account: string; // best-effort username/handle captured at save time ("" = unknown)
  user_agent: string;
  device_model: string;
  stale: boolean;
  created_at: string;
  updated_at: string;
  /** v20+: cookie name -> capture domain (e.g. "contentrewards.com"). Lets the
   *  dashboard show cookies category-wise (Whop vs Content Rewards). */
  cookie_domains?: Record<string, string>;
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
  /** campaign needs an application/review before joining (fail-closed: auto-flow skips) */
  requiresApplication?: boolean;
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
  /** arbitrary per-job inputs, e.g. { video_url } for ig_post (read by phone JobEngine) */
  payload?: Record<string, unknown>;
  /** campaign this job belongs to (set by orchestrator; fallback for submission recording) */
  campaign_id?: string;
  result: unknown;
  created_at: string;
  updated_at: string;
  /** live progress: last step index/name the phone reported */
  current_step?: string | null;
  /** last heartbeat ISO time (phone pings during long jobs) */
  last_heartbeat?: string | null;
  /** heartbeat count (stuck-job detection) */
  heartbeat_count?: number;
  /** owner asked to cancel a running job; the phone sees it on next heartbeat */
  cancel_requested?: boolean;
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
    this.m.set(key, { value, updated_at: nextVersion() });
  }
  async cas(key: string, value: unknown, updatedAt: string) {
    const cur = this.m.get(key);
    if (!cur || cur.updated_at !== updatedAt) return false;
    // nextVersion() is unique per write (random microsecond digits), so a
    // concurrent loser can never match again — even in the same millisecond.
    this.m.set(key, { value, updated_at: nextVersion() });
    return true;
  }
  /** used only for atomic claim: fetch raw row with updated_at */
  async getRow(key: string) {
    return this.m.get(key) ?? null;
  }
}

const mem = new MemoryKV();

/* ---- Phase 0 cutover: read-source + write-mode aware backend ----
 * Defaults (no env set): read supabase, write supabase — today's exact behavior.
 * Dual phase:   KV_WRITE_MODE=dual   (reads supabase, writes both)
 * Read switch:  KV_READ_SOURCE=turso + KV_WRITE_MODE=dual
 * Rollback:     unset both (or set back to supabase/supabase).
 * Turso is only used when TURSO_AUTH_TOKEN is set (tursoEnabled).
 */
function buildBackends(): { read: KVBackendEx | null; kv: KVBackend } {
  const readTurso = kvReadSource() === "turso" && tursoEnabled;
  const writeMode = kvWriteMode();
  const read: KVBackendEx | null = readTurso
    ? tursoKV
    : dbEnabled
      ? supabaseKV
      : null;
  if (!read) return { read: null, kv: mem };
  const other: KVBackendEx | null =
    read === tursoKV ? (dbEnabled ? supabaseKV : null)
    : tursoEnabled ? tursoKV
    : null;
  let kv: KVBackend = read;
  if (writeMode === "dual" && other) kv = dualKV(read, [other]);
  else if (writeMode === "turso" && other && read !== tursoKV) kv = tursoKV;
  else if (writeMode === "turso" && read === tursoKV) kv = tursoKV;
  return { read, kv };
}

const { read: readBackend, kv: selectedKv } = buildBackends();
const kv: KVBackend = selectedKv;
export { kv };
/** Which backend serves reads right now (for health/debug endpoints). */
export function kvBackendName(): string {
  if (!readBackend) return "memory";
  return readBackend === tursoKV ? "turso" : "supabase";
}
if (!dbEnabled && !tursoEnabled) {
  console.warn("[whopclip] SUPABASE_SERVICE_ROLE_KEY and TURSO_AUTH_TOKEN not set — using ephemeral in-memory store");
}

/** Fetch a value plus its updated_at (for CAS). Exported so other modules
 *  can build atomic check-and-set operations on top of the same backend.
 *  Reads from the configured read backend (supabase by default). */
export async function getWithTs(key: string): Promise<{ value: unknown; updated_at: string } | null> {
  if (!readBackend) return mem.getRow(key);
  return readBackend.getWithTs(key);
}

/** Atomic compare-and-swap on updated_at: writes only if no other writer
 *  changed the row since getWithTs. Returns true iff this writer won.
 *  This is the primitive for all cross-pump mutual exclusion (upload
 *  locks, post-slot reservation). In dual-write mode the win propagates
 *  to the secondary backend. */
export async function casKey(
  key: string,
  value: unknown,
  updatedAt: string
): Promise<boolean> {
  if (!readBackend) return mem.cas(key, value, updatedAt);
  return kv.cas(key, value, updatedAt);
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

/** Clears the stale flag (session verified healthy again). */
export async function clearSessionStale(device_id: string, service: ServiceName): Promise<void> {
  const s = await getSession(device_id, service);
  if (!s || !s.stale) return;
  s.stale = false;
  s.updated_at = new Date().toISOString();
  await kv.set(sessionKey(device_id, service), s);
}

export async function sessionStatus(device_id: string): Promise<
  Record<ServiceName, { linked: boolean; stale: boolean; account: string; updated_at: string }>
> {
  const out = {} as Record<ServiceName, { linked: boolean; stale: boolean; account: string; updated_at: string }>;
  for (const svc of ["whop", "instagram"] as ServiceName[]) {
    const s = await getSession(device_id, svc);
    out[svc] = {
      linked: !!s,
      stale: s?.stale === true,
      account: s?.account ?? "",
      updated_at: s?.updated_at ?? "",
    };
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
  // Parallel: ~100 campaigns x ~250ms USA->Mumbai RTT would exceed the
  // Vercel function deadline sequentially (2026-09-23: advance/chain reads
  // started 504ing after discover grew the store past ~100 campaigns).
  const all = await Promise.all(ids.map((id) => getCampaign(id).catch(() => null)));
  return all.filter((c): c is Campaign => !!c);
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
  await logActivity(job.device_id, "job_enqueued", `Enqueued: ${job.type}`, job);
  // FCM wake (best-effort, enqueue path kabhi block nahi hota): device
  // offline dikh raha ho aur uska FCM token registered ho to ek wake push
  // bhejo taaki phone turant poll kare. Floating promise — fail-soft.
  void wakeDeviceIfOffline(job.device_id, {
    type: "wake",
    job_id: job.id,
    job_type: job.type,
  }).catch(() => {});
}

/**
 * Device offline dikh raha ho to ek best-effort FCM wake push bhejo.
 * Kabhi throw nahi karta — enqueue/cron paths is par depend nahi karte.
 */
export async function wakeDeviceIfOffline(
  device_id: string,
  data?: Record<string, string>
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const d = await getDevice(device_id);
    if (!d || deviceOnline(d)) return { ok: false, reason: "online_or_unknown" };
    const token = await getDeviceFcmToken(device_id);
    if (!token) return { ok: false, reason: "no_token" };
    const r = await sendPush(token, {
      title: "WhopClip",
      body: "Naya kaam aaya hai — app kholo aur sync karo.",
      data,
    });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch {
    return { ok: false, reason: "fcm_error" };
  }
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
    const ok = await casKey(`job:${id}`, claimed, row.updated_at);
    if (ok) {
      await logActivity(device_id, "job_claimed", `Phone ne uthaya: ${claimed.type}`, claimed);
      return claimed;
    }
    // lost the race — try next
  }
  return null;
}

export async function requeueJob(id: string, reason?: string): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  job.status = "queued";
  job.cancel_requested = false;
  job.updated_at = new Date().toISOString();
  await kv.set(`job:${id}`, job);
  await logActivity(job.device_id, "job_requeued", reason ?? `Dobara queue me: ${job.type}`, job);
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
  // Job khatam — uska live screenshot bhi turant hata do (10-min expiry
  // ka wait nahi). Best-effort: kabhi finish ko fail nahi karta.
  try {
    await clearLiveFrame(job.device_id);
  } catch {
    /* live frame cleanup is best-effort */
  }
  const kind =
    status === "done" ? "job_done" : status === "failed" ? "job_failed" : "job_cancelled";
  const msg =
    status === "done"
      ? `Ho gaya ✓: ${job.type}`
      : status === "failed"
        ? `Fail ✗: ${job.type}`
        : `Cancel: ${job.type}`;
  await logActivity(job.device_id, kind, msg, job);
  return job;
}

/**
 * Owner-initiated cancel. Queued jobs are cancelled immediately; running
 * jobs get cancel_requested=true and the phone aborts on its next heartbeat
 * (fail-safe: a dead phone never blocks a cancel — requeue-stuck still works).
 * Terminal jobs (done/failed/cancelled) are never touched.
 */
export async function cancelJob(id: string): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return job;
  }
  if (job.status === "queued") {
    job.status = "cancelled";
    job.updated_at = new Date().toISOString();
    await kv.set(`job:${id}`, job);
    await logActivity(job.device_id, "job_cancelled", `Cancel (queued tha): ${job.type}`, job);
  } else {
    job.cancel_requested = true;
    job.updated_at = new Date().toISOString();
    await kv.set(`job:${id}`, job);
    await logActivity(job.device_id, "job_cancel_requested", `Cancel bheja — phone agle heartbeat pe rokega: ${job.type}`, job);
  }
  return job;
}

/**
 * Live heartbeat: the phone pings this during long-running jobs with its
 * current step. Used for stuck-job detection and the dashboard's live view.
 * Only updates running jobs; never resurrects finished ones.
 */
export async function heartbeatJob(
  id: string,
  current_step: string
): Promise<Job | null> {
  const job = await getJob(id);
  if (!job || job.status !== "running") return null;
  job.current_step = current_step;
  job.last_heartbeat = new Date().toISOString();
  job.heartbeat_count = (job.heartbeat_count ?? 0) + 1;
  job.updated_at = job.last_heartbeat;
  await kv.set(`job:${id}`, job);
  return job;
}

/**
 * Stuck-job recovery: find jobs stuck in "running" with no heartbeat for
 * longer than the threshold, and requeue them. Returns the requeued jobs.
 * Called by the schedule tick so dead phones don't block the pipeline.
 */
export async function requeueStuckJobs(
  device_id: string,
  staleAfterMs = 10 * 60 * 1000
): Promise<Job[]> {
  const jobs = await listJobs(device_id);
  const now = Date.now();
  const requeued: Job[] = [];
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const last = job.last_heartbeat ?? job.updated_at;
    if (now - new Date(last).getTime() < staleAfterMs) continue;
    if (job.cancel_requested) {
      // Owner ne cancel manga tha — ise dobara zinda mat karo. (fix 2026-09-23)
      // heartbeat nahi bheja (offline/mara hua), to server-side hi cancelled
      // finalize karo taaki ye kabhi claim na ho.
      job.status = "cancelled";
      job.cancel_requested = false;
      job.updated_at = new Date().toISOString();
      await kv.set(`job:${job.id}`, job);
      await logActivity(job.device_id, "job_cancelled", `Cancel finalize (stuck + cancel_requested): ${job.type}`, job);
      continue;
    }
    const r = await requeueJob(job.id, `Stuck tha (heartbeat ${(Math.round((now - new Date(last).getTime()) / 60000))}m purana) — dobara queue: ${job.type}`);
    if (r) requeued.push(r);
  }
  return requeued;
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

/**
 * Normalizes a user-typed pair code: uppercase, strip dashes/spaces/other
 * separators. Phones often drop the dash when typing; lookup must not fail
 * for that. "abcd-1234", "abcd1234", "abcd 1234" all -> "ABCD1234".
 */
export function normalizePairCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function createPairCode(ttlMinutes = 30): Promise<PairCode> {
  const now = new Date();
  const p: PairCode = {
    code: generatePairCode(),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMinutes * 60000).toISOString(),
    claimed_by: null,
    claimed_at: null,
  };
  // Store under the normalized (dashless) key so typed-with/without-dash
  // lookups both hit. Displayed code keeps the XXXX-XXXX form.
  await kv.set(`pair:${normalizePairCode(p.code)}`, p);
  return p;
}

export async function getPairCode(code: string): Promise<PairCode | null> {
  const norm = normalizePairCode(code);
  if (!norm) return null;
  // New codes are stored dashless; old ones as XXXX-XXXX — try both.
  const tries = [`pair:${norm}`];
  if (norm.length === 8) tries.push(`pair:${norm.slice(0, 4)}-${norm.slice(4)}`);
  for (const k of tries) {
    const v = await kv.get(k);
    if (v) return v as PairCode;
  }
  return null;
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
  // Re-store under the normalized key so the claim sticks regardless of
  // which key form the code was found under.
  await kv.set(`pair:${normalizePairCode(p.code)}`, p);
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

/** Online = polled within the last 30 minutes.
 * This window must stay comfortably ABOVE the phone's 15-min PollWorker
 * interval: with the old 5-min window the server reported "offline" ~10 min
 * out of every 15 even when the phone was perfectly healthy (2026-09-23),
 * which is what the app's Profile "Server status" line shows. */
export function deviceOnline(d: Device): boolean {
  if (!d.last_poll_at) return false;
  return Date.now() - new Date(d.last_poll_at).getTime() < 30 * 60 * 1000;
}

/** Explicit online/offline presence from the phone's Profile tab. */
export async function setDevicePresence(device_id: string, online: boolean): Promise<void> {
  const existing = await getDevice(device_id);
  if (!existing) return;
  await kv.set(`device:${device_id}`, {
    ...existing,
    last_poll_at: online ? new Date().toISOString() : null,
    presence: online ? "online" : "offline",
  });
}

/** Full disconnect: removes the device registration (unpair). */
export async function disconnectDevice(device_id: string): Promise<void> {
  // KVBackend has no delete — null the record and drop from the index.
  await kv.set(`device:${device_id}`, null);
  const ids = await getIdx("devices");
  await kv.set("idx:devices", ids.filter((id) => id !== device_id));
}

/* ---------------- device FCM tokens ----------------
 * Key: `device_token:${device_id}` (db.ts layer `whopclip:` prefix lagata
 * hai, dual-write/Turso yahan se automatic). Phone apna FCM registration
 * token /api/devices/token se register karta hai; server wake push ke liye
 * yahan se padhta hai. Token change ho to upsert se overwrite ho jata hai.
 */

const deviceTokenKey = (device_id: string) => `device_token:${device_id}`;

/** Register/upsert the phone's FCM registration token. */
export async function saveDeviceFcmToken(
  device_id: string,
  fcm_token: string
): Promise<void> {
  await kv.set(deviceTokenKey(device_id), {
    fcm_token,
    updated_at: new Date().toISOString(),
  });
}

/** The phone's registered FCM token, or null when none. */
export async function getDeviceFcmToken(
  device_id: string
): Promise<string | null> {
  const v = (await kv.get(deviceTokenKey(device_id))) as {
    fcm_token?: unknown;
  } | null;
  const t = v?.fcm_token;
  return typeof t === "string" && t.length > 0 ? t : null;
}

/** Unregister (KVBackend has no delete — null the record). */
export async function clearDeviceFcmToken(device_id: string): Promise<void> {
  await kv.set(deviceTokenKey(device_id), null);
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

/* ---------------- activity timeline ---------------- */

/**
 * Durable per-device event timeline ("kya hua, kab hua"): every job
 * lifecycle event is logged here so the dashboard Live tab can show a real
 * activity feed under the live frame — not just the current job list.
 * Capped at 200 events per device (zero-SQL KV, newest first on read).
 */
export interface ActivityEvent {
  id: string;
  device_id: string;
  kind: string; // job_enqueued | job_claimed | job_done | job_failed | job_cancelled | job_cancel_requested | job_retried | job_requeued
  message: string;
  job_id?: string;
  job_type?: string;
  created_at: string;
}

const ACTIVITY_CAP = 200;

export async function logActivity(
  device_id: string,
  kind: ActivityEvent["kind"],
  message: string,
  job?: { id: string; type: string } | null
): Promise<void> {
  if (!device_id) return;
  try {
    const ev: ActivityEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      device_id,
      kind,
      message,
      job_id: job?.id,
      job_type: job?.type,
      created_at: new Date().toISOString(),
    };
    await kv.set(`activity:${device_id}:${ev.id}`, ev);
    const idxKey = `idx:activity:${device_id}`;
    const ids = [...((await kv.get(idxKey)) as string[] | null ?? []), ev.id];
    // cap: drop oldest
    const trimmed = ids.slice(-ACTIVITY_CAP);
    await kv.set(idxKey, trimmed);
  } catch {
    /* activity logging must never break job flow */
  }
}

export async function listActivity(
  device_id: string,
  limit = 50
): Promise<ActivityEvent[]> {
  const ids = ((await kv.get(`idx:activity:${device_id}`)) as string[] | null) ?? [];
  const out: ActivityEvent[] = [];
  for (const id of ids.slice(-limit).reverse()) {
    const ev = (await kv.get(`activity:${device_id}:${id}`)) as ActivityEvent | null;
    if (ev) out.push(ev);
  }
  return out;
}

/* ---------------- live activity ---------------- */

/**
 * Latest live frame per device: the phone uploads a downscaled WebView
 * screenshot (key "live") after every job step, plus a heartbeat with the
 * current step. The dashboard Live tab shows this — "phone abhi kya kar
 * raha hai" — with the job history below it.
 */
export interface LiveFrame {
  device_id: string;
  job_id: string;
  job_type: string;
  current_step: string;
  frame_url: string;
  updated_at: string;
}

export async function setLiveFrame(
  f: Omit<LiveFrame, "updated_at">
): Promise<LiveFrame> {
  const full: LiveFrame = { ...f, updated_at: new Date().toISOString() };
  await kv.set(`liveframe:${f.device_id}`, full);
  return full;
}

export async function getLiveFrame(device_id: string): Promise<LiveFrame | null> {
  return (await kv.get(`liveframe:${device_id}`)) as LiveFrame | null;
}

/**
 * Live frames expire after 10 min (user rule: screenshots must not
 * accumulate storage). GET /api/live lazily expires them — the dashboard
 * polls it every 5s, so expiry + storage-object deletion happens on the
 * next read after the TTL. Deletion convention here is kv.set(key, null).
 */
export const LIVE_FRAME_TTL_MS = 10 * 60 * 1000;

export async function clearLiveFrame(device_id: string): Promise<LiveFrame | null> {
  const cur = await getLiveFrame(device_id);
  await kv.set(`liveframe:${device_id}`, null);
  return cur;
}
