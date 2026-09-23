/**
 * Server-side Instagram Reel upload (Vercel, USA).
 *
 * Uses the phone-uploaded IG session (AES-256-GCM at rest, decrypted IN
 * MEMORY ONLY, never logged/returned) with the maintained
 * `instagram-private-api` fork (marinac-dev). No password login ever —
 * the web `sessionid` is accepted by the mobile endpoints.
 *
 * Vercel Hobby gives 10s per invocation, but a reel upload is:
 *   binary upload (rupload) -> upload_finish -> transcode wait -> configure
 * So the upload is a PHASED state machine, one phase per pump:
 *   new -> uploading (binary+cover uploaded) -> transcoding -> done
 * Each pump (phone poll -> /api/chains/advance, or dashboard "Pump chains")
 * advances exactly one phase. State lives in KV under `igpost:<chain_id>`.
 *
 * Safety:
 *  - Duplicate-post protection, three layers:
 *    a) the KV record (`igpost:<chain_id>`) is the point of no return;
 *       `configure` (the only call that publishes) runs only when no record
 *       says `done`;
 *    b) concurrent pumps are serialized by an ATOMIC per-chain lock
 *       (`igpost-lock:<chain_id>`, CAS on updated_at — never check-then-set);
 *    c) before EVERY configure retry after an ambiguous attempt, the
 *       account's recent media is reconciled (duration + caption fingerprint)
 *       and configure is skipped when the reel is already published.
 *  - Daily post-slot reservation: max 4 posts/device/UTC-day with 3h
 *    spacing, reserved atomically (CAS) immediately before configure.
 *  - Cover is a REAL source frame supplied by the render worker
 *    (cover_url); a missing/invalid cover fails closed — no placeholder.
 *  - Device fingerprint stability: `generateDevice()` runs ONCE per account;
 *    the serialized state is persisted (`igstate:<device_id>`) and restored
 *    on every pump. Never re-generate after restore.
 *  - Error mapping is fail-closed: session expiry -> mark stale (phone shows
 *    "login again"); checkpoint / action-block -> stop, never auto-retry;
 *    429 -> retryable backoff; 400 on configure -> protocol drift, don't hammer.
 *  - Video is validated before upload: portrait, ~9:16, 3s..15min.
 */

import crypto from "crypto";
import { decryptSession } from "./crypto";
import { getSession, markSessionStale, kv, sessionStatus, getWithTs, casKey } from "./store";
import { tryReservePostSlot } from "./postslots";

export type IgPostPhase = "new" | "uploading" | "transcoding" | "done";

export interface IgPostResult {
  ok: boolean;
  /** canonical reel URL, e.g. https://www.instagram.com/reel/<shortcode>/ */
  post_url?: string;
  /** instagram media id, when known */
  media_id?: string;
  /** phase after this pump (in-progress), or "busy" when another pump holds the lock */
  phase?: IgPostPhase | "busy";
  error?: string;
  /** safe to retry on a later pump without consuming a chain attempt */
  retryable?: boolean;
  /** definitive auth expiry — caller should surface "login again" */
  session_expired?: boolean;
}

interface PostRecord {
  phase: IgPostPhase;
  upload_id?: string;
  width?: number;
  height?: number;
  /** ms */
  duration?: number;
  post_url?: string;
  media_id?: string;
  /** ambiguous configure attempts so far (bounded; see Phase C) */
  configure_attempts?: number;
  updated_at: string;
}

/** Per-chain pump lock value. */
interface UploadLock {
  /** epoch ms until which the lock is held */
  until: number;
  /** random token of the holder — release only succeeds for the holder */
  token: string;
}

const recKey = (chain_id: string) => `igpost:${chain_id}`;
const lockKey = (chain_id: string) => `igpost-lock:${chain_id}`;
const stateKey = (device_id: string) => `igstate:${device_id}`;
const LOCK_TTL_MS = 120_000;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const SOFT_DEADLINE_MS = 8_500; // stay well inside Vercel's 10s
/** Max configure attempts per chain before failing closed for human review. */
const MAX_CONFIGURE_ATTEMPTS = 3;

class SessionExpiredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SessionExpiredError";
  }
}
class RetryableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RetryableError";
  }
}

function isInst(e: any, errors: Record<string, any>, key: string): boolean {
  return typeof errors[key] === "function" && e instanceof errors[key];
}

/** Lazy-load the heavy CJS lib only on the upload path (keeps other routes' cold start small). */
async function loadIg(): Promise<{
  IgApiClient: any;
  CookieJar: any;
  errors: Record<string, any>;
}> {
  const mod = await import("instagram-private-api");
  const tc = await import("tough-cookie");
  return {
    IgApiClient: mod.IgApiClient,
    CookieJar: tc.CookieJar,
    errors: {
      IgLoginRequiredError: mod.IgLoginRequiredError,
      IgUserHasLoggedOutError: mod.IgUserHasLoggedOutError,
      IgCheckpointError: mod.IgCheckpointError,
      IgActionSpamError: mod.IgActionSpamError,
      IgRequestsLimitError: mod.IgRequestsLimitError,
      IgResponseError: mod.IgResponseError,
    },
  };
}

/** MP4 box walk (same algorithm as the lib's PublishService.getVideoInfo). */
function readBytes(buffer: Buffer, keys: string[], offset: number, size: 2 | 4): number {
  let start = 0;
  for (const key of keys) {
    start = buffer.indexOf(Buffer.from(key), start) + key.length;
  }
  return size === 2 ? buffer.readUInt16BE(start + offset) : buffer.readUInt32BE(start + offset);
}
function getVideoInfo(buffer: Buffer): { duration: number; width: number; height: number } {
  const width = readBytes(buffer, ["moov", "trak", "stbl", "avc1"], 24, 2);
  const height = readBytes(buffer, ["moov", "trak", "stbl", "avc1"], 26, 2);
  const timescale = readBytes(buffer, ["moov", "mvhd"], 12, 4);
  const length = readBytes(buffer, ["moov", "mvhd"], 16, 4);
  return { duration: Math.floor((length / timescale) * 1000), width, height };
}

/**
 * Build an authenticated IgApiClient from the saved web session.
 * Throws SessionExpiredError on definitive auth expiry.
 */
async function bootstrapClient(device_id: string): Promise<{ ig: any; errors: Record<string, any> }> {
  const { IgApiClient, CookieJar, errors } = await loadIg();
  const s = await getSession(device_id, "instagram");
  if (!s) throw new SessionExpiredError("no instagram session saved for this device");
  let cookies: Record<string, string>;
  try {
    cookies = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
  } catch {
    throw new SessionExpiredError("instagram session decrypt failed");
  }
  const names = Object.keys(cookies).filter((k) => k && cookies[k]);
  if (names.length === 0 || !cookies["sessionid"]) {
    throw new SessionExpiredError("instagram session has no sessionid cookie");
  }

  const ig = new IgApiClient();
  // Restore persisted device fingerprint (generate ONCE per account).
  // CRITICAL: We must do a SINGLE deserialize with the merged state.
  // The old code did deserialize(saved) then deserialize({cookies}) —
  // the second call WIPED the device fingerprint, causing Instagram
  // to see a new device on every pump (auth failures / checkpoints).
  let stateToRestore: Record<string, unknown> | null = null;
  const saved = (await kv.get(stateKey(device_id))) as Record<string, unknown> | null;
  if (saved && typeof saved === "object" && (saved as any).cookies) {
    stateToRestore = saved;
  } else {
    let username = "instagram_user";
    try {
      const st = await sessionStatus(device_id);
      const acc = (st.instagram?.account ?? "").replace(/^@/, "").trim();
      if (acc) username = acc;
    } catch {
      /* keep fallback */
    }
    ig.state.generateDevice(username);
    stateToRestore = (await ig.state.serialize()) as Record<string, unknown>;
  }
  // Inject the phone-harvested WEB cookies into the state, preserving
  // the device fingerprint. Domain=.instagram.com is essential: the
  // library talks to i.instagram.com, a host-only www.instagram.com
  // cookie would never be sent.
  const jar = new CookieJar();
  for (const [k, v] of Object.entries(cookies)) {
    if (!k || v == null || v === "") continue;
    try {
      jar.setCookieSync(`${k}=${v}; Domain=.instagram.com; Path=/`, "https://www.instagram.com");
    } catch {
      /* skip malformed */
    }
  }
  // Merge: keep device fingerprint + all state, replace ONLY the cookies.
  await ig.state.deserialize({
    ...stateToRestore,
    cookies: jar.serializeSync(),
  });

  // Validate the session without any password login.
  try {
    await ig.account.currentUser();
  } catch (e: any) {
    if (isAuthExpired(e, errors)) {
      throw new SessionExpiredError("instagram login required (session expired)");
    }
    throw e;
  }
  // Persist refreshed state for fingerprint stability.
  try {
    await kv.set(stateKey(device_id), await ig.state.serialize());
  } catch {
    /* non-fatal */
  }
  return { ig, errors };
}

function isAuthExpired(e: any, errors: Record<string, any>): boolean {
  if (!e) return false;
  const LoginRequired = errors.IgLoginRequiredError;
  const LoggedOut = errors.IgUserHasLoggedOutError;
  if (
    (typeof LoginRequired === "function" && e instanceof LoginRequired) ||
    (typeof LoggedOut === "function" && e instanceof LoggedOut)
  )
    return true;
  const msg = String(e.message ?? "");
  return (
    /login_required/i.test(msg) ||
    (e.response?.statusCode === 403 && /login_required/i.test(JSON.stringify(e.response?.body ?? "")))
  );
}

async function downloadVideo(url: string, startedAt: number): Promise<Buffer> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) {
      throw new RetryableError(`video download failed: HTTP ${res.status}`);
    }
    const len = res.headers.get("content-length");
    if (len && parseInt(len, 10) > MAX_VIDEO_BYTES) {
      throw new Error(`video too large (${len} bytes)`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        throw new RetryableError("video download exceeded time budget");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_VIDEO_BYTES) throw new Error("video too large (>100MB)");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (e: any) {
    if (e?.name === "AbortError") throw new RetryableError("video download timed out");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const MAX_COVER_BYTES = 5 * 1024 * 1024;

/**
 * Download the render worker's real cover frame. FAILS CLOSED: a missing,
 * unreachable, or non-image cover refuses the upload — no placeholder is
 * ever generated (a placeholder would violate the 1s-hook visual check).
 */
async function downloadCover(url: string, startedAt: number): Promise<Buffer> {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("no cover_url supplied by the render worker — refusing to post with a placeholder");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) {
      throw new RetryableError(`cover download failed: HTTP ${res.status}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        throw new RetryableError("cover download exceeded time budget");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_COVER_BYTES) throw new Error("cover image too large (>5MB)");
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 16) throw new Error("cover download returned empty body");
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isJpeg && !isPng) {
      throw new Error("cover_url did not return a JPEG/PNG image — refusing placeholder");
    }
    return buf;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new RetryableError("cover download timed out");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pre-create the per-chain pump lock row (unlocked) so the first real
 * acquisition is a pure CAS. Called once at chain start; safe to re-run.
 */
export async function seedUploadLock(chain_id: string): Promise<void> {
  try {
    const existing = await kv.get(lockKey(chain_id));
    if (existing == null) {
      await kv.set(lockKey(chain_id), { until: 0, token: "" } as UploadLock);
    }
  } catch {
    /* non-fatal: first pump falls back to seed-on-acquire */
  }
}

/**
 * Atomically acquire the per-chain pump lock via CAS on updated_at.
 * Returns the holder token when acquired, null when another pump holds it.
 * NEVER proceeds on a lost race — the caller must report busy / park.
 */
async function acquireUploadLock(chain_id: string): Promise<string | null> {
  const key = lockKey(chain_id);
  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getWithTs(key);
    if (!row) {
      // Legacy chain (created before lock seeding) — seed, then CAS.
      await kv.set(key, { until: 0, token: "" } as UploadLock);
      continue;
    }
    const v = row.value as Partial<UploadLock> | null;
    const until = typeof v?.until === "number" ? v.until : 0;
    if (until > now) return null; // held by another pump
    const token = crypto.randomUUID();
    const next: UploadLock = { until: now + LOCK_TTL_MS, token };
    if (await casKey(key, next, row.updated_at)) return token;
    return null; // lost the CAS race — fail closed as busy
  }
  return null;
}

/** Release the lock only if we still hold it (never release another's). */
async function releaseUploadLock(chain_id: string, token: string): Promise<void> {
  const key = lockKey(chain_id);
  try {
    const row = await getWithTs(key);
    const v = row?.value as Partial<UploadLock> | null;
    if (row && v?.token === token) {
      await kv.set(key, { until: 0, token: "" } as UploadLock);
    }
  } catch {
    /* non-fatal */
  }
}

/** A reel we already published (found by reconciliation). */
interface RecentMedia {
  code: string;
  id: string;
}

const RECONCILE_WINDOW_S = 30 * 60;

/**
 * Look for a reel THIS chain published but whose configure response was
 * lost. Fingerprint = duration (±2s) + exact caption text, within the last
 * 30 minutes. Reconciliation runs ONLY after an ambiguous configure attempt
 * (never on the first configure), so it can never adopt a reel the user
 * posted manually from the IG app.
 *
 * Throws on feed errors — the caller must treat "cannot check" as
 * "must not configure" (fail closed), never as "nothing published".
 */
async function findOurRecentMedia(
  ig: any,
  durationS: number,
  caption: string
): Promise<RecentMedia | null> {
  const user = await ig.account.currentUser();
  const pk = user?.pk;
  if (!pk) throw new Error("could not resolve account pk for reconcile");
  const items = await ig.feed.user(pk).items();
  const nowS = Date.now() / 1000;
  const wantCap = caption.trim().replace(/\s+/g, " ");
  for (const it of items ?? []) {
    if (it?.media_type !== 2) continue; // video only
    const taken = Number(it.taken_at ?? 0);
    if (!taken || nowS - taken > RECONCILE_WINDOW_S) continue;
    const d = Number(it.video_duration ?? 0);
    if (!d || Math.abs(d - durationS) > 2) continue;
    const gotCap = String(it.caption?.text ?? "").trim().replace(/\s+/g, " ");
    if (!gotCap || gotCap !== wantCap) continue;
    const code = String(it.code ?? "");
    if (!code) continue;
    return { code, id: String(it.id ?? "") };
  }
  return null;
}

function validateVideo(info: { duration: number; width: number; height: number }): void {
  const { duration, width, height } = info;
  if (!width || !height) throw new Error("could not read video dimensions");
  if (height < width) throw new Error(`video is landscape (${width}x${height}) — only 9:16 accepted`);
  const ratio = width / height;
  if (ratio < 0.5 || ratio > 0.65) {
    throw new Error(`video aspect ${ratio.toFixed(3)} is not ~9:16 — refusing (no crop allowed)`);
  }
  const secs = duration / 1000;
  if (secs < 3) throw new Error(`video too short (${secs.toFixed(1)}s)`);
  if (secs > 15 * 60) throw new Error(`video too long (${secs.toFixed(0)}s > 15min)`);
}

/** Map a thrown error to a fail-closed IgPostResult. */
async function mapError(e: unknown, device_id: string, errors: Record<string, any>): Promise<IgPostResult> {
  if (e instanceof SessionExpiredError || isAuthExpired(e, errors)) {
    try {
      await markSessionStale(device_id, "instagram");
    } catch {
      /* non-fatal */
    }
    return { ok: false, error: "ig_session_expired", session_expired: true };
  }
  if (e instanceof RetryableError) {
    return { ok: false, error: e.message, retryable: true };
  }
  const msg = e instanceof Error ? e.message : String(e ?? "unknown");
  const body = (() => {
    try {
      return JSON.stringify((e as any)?.response?.body ?? "");
    } catch {
      return "";
    }
  })();
  const statusCode = (e as any)?.response?.statusCode as number | undefined;
  if (isInst(e, errors, "IgCheckpointError") || /challenge_required|checkpoint_required/i.test(msg + body)) {
    return { ok: false, error: "ig_checkpoint: account flagged, human review needed" };
  }
  if (isInst(e, errors, "IgActionSpamError") || (/feedback_required/i.test(body) && /spam/i.test(body))) {
    return { ok: false, error: "ig_action_blocked: post throttled, backing off" };
  }
  if (isInst(e, errors, "IgRequestsLimitError") || statusCode === 429) {
    return { ok: false, error: "ig_rate_limited", retryable: true };
  }
  if (statusCode === 400) {
    return { ok: false, error: `ig_protocol_error (400): ${msg.slice(0, 160)}` };
  }
  if (/timeout|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)) {
    return { ok: false, error: msg.slice(0, 160), retryable: true };
  }
  return { ok: false, error: msg.slice(0, 200) };
}

/**
 * Advance the reel upload one phase. Idempotent per chain_id:
 *  - returns the existing post_url if this chain already posted,
 *  - resumes an in-flight upload instead of starting a second one.
 *
 * cover_url (a REAL source frame from the render worker) is REQUIRED —
 * a missing/invalid cover fails closed; no placeholder is ever generated.
 */
export async function postReelToInstagram(
  device_id: string,
  chain_id: string,
  video_url: string,
  cover_url: string,
  caption: string
): Promise<IgPostResult> {
  const startedAt = Date.now();
  let errors: Record<string, any> = {};
  try {
    // Fast idempotency: already posted for this chain?
    const existing = (await kv.get(recKey(chain_id))) as PostRecord | null;
    if (existing?.phase === "done" && existing.post_url) {
      return { ok: true, post_url: existing.post_url, media_id: existing.media_id, phase: "done" };
    }

    // Serialize concurrent pumps (phone poll + dashboard pump) with an
    // ATOMIC lock — CAS on updated_at, never check-then-set.
    const token = await acquireUploadLock(chain_id);
    if (!token) {
      return { ok: false, phase: "busy", error: "another upload pump holds the lock", retryable: true };
    }

    try {
      return await runPhases(device_id, chain_id, video_url, cover_url, caption, existing, startedAt);
    } finally {
      await releaseUploadLock(chain_id, token);
    }
  } catch (e: unknown) {
    return mapError(e, device_id, errors);
  }
}

async function runPhases(
  device_id: string,
  chain_id: string,
  video_url: string,
  cover_url: string,
  caption: string,
  existing: PostRecord | null,
  startedAt: number
): Promise<IgPostResult> {
  const { ig, errors } = await bootstrapClient(device_id);
  const saveState = async () => {
    try {
      await kv.set(stateKey(device_id), await ig.state.serialize());
    } catch {
      /* non-fatal */
    }
  };

  let rec = existing;
  // ---- Phase A: download, validate, binary upload + cover ----
  if (!rec || rec.phase === "new" || (rec.phase === "uploading" && !rec.upload_id)) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      throw new RetryableError("time budget exceeded before upload");
    }
    const video = await downloadVideo(video_url, startedAt);
    const info = getVideoInfo(video);
    validateVideo(info);
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      throw new RetryableError("time budget exceeded before upload");
    }
    const uploadId = Date.now().toString();
    try {
      await ig.upload.video({
        video,
        uploadId,
        duration: info.duration,
        width: info.width,
        height: info.height,
      });
      // Real source frame from the render worker — fail closed if missing.
      const cover = await downloadCover(cover_url, startedAt);
      await ig.upload.photo({ file: cover, uploadId });
    } catch (e: any) {
      if (isInst(e, errors, "IgResponseError")) {
        const wrapped = new Error(`rupload failed: ${e.message}`);
        (wrapped as any).response = e.response;
        Object.setPrototypeOf(wrapped, Object.getPrototypeOf(e));
        throw wrapped;
      }
      throw e;
    }
    rec = {
      phase: "uploading",
      upload_id: uploadId,
      width: info.width,
      height: info.height,
      duration: info.duration,
      updated_at: new Date().toISOString(),
    };
    await kv.set(recKey(chain_id), rec);
    await saveState();
  }

  if (!rec.upload_id || !rec.duration || !rec.width || !rec.height) {
    throw new Error("upload record corrupted — refusing to continue");
  }

  // ---- Phase B: upload_finish (transcode gate; may need several pumps) ----
  if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
    return { ok: true, phase: "transcoding" };
  }
  try {
    await ig.media.uploadFinish({
      upload_id: rec.upload_id,
      source_type: "4",
      video: { length: rec.duration / 1000 },
    });
  } catch (e: any) {
    const statusCode = e?.response?.statusCode;
    const msg = String(e?.message ?? "");
    if (statusCode === 202 || /transcode/i.test(msg)) {
      // Transcode still pending — park; the next pump retries upload_finish.
      rec.phase = "transcoding";
      rec.updated_at = new Date().toISOString();
      await kv.set(recKey(chain_id), rec);
      await saveState();
      return { ok: true, phase: "transcoding" };
    }
    throw e;
  }

  // ---- Phase C: configure (THE publish point of no return) ----
  if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
    // upload_finish said ok; configure on the next pump to stay in budget.
    rec.phase = "transcoding";
    rec.updated_at = new Date().toISOString();
    await kv.set(recKey(chain_id), rec);
    await saveState();
    return { ok: true, phase: "transcoding" };
  }

  const durationS = rec.duration / 1000;
  const priorAttempts = rec.configure_attempts ?? 0;

  // (2) Reconcile FIRST on any pump that follows an ambiguous attempt: if
  // the earlier configure published but the response was lost, adopt the
  // existing reel — NEVER re-configure into a duplicate post, and never
  // burn another daily slot for a post that already exists.
  if (priorAttempts > 0) {
    let found: RecentMedia | null = null;
    try {
      found = await findOurRecentMedia(ig, durationS, caption);
    } catch (e: any) {
      // "Cannot check" is NOT "nothing published" — fail closed, retry later.
      throw new RetryableError(
        `reconcile check failed (${e?.message ?? "unknown"}) — refusing to configure blind`
      );
    }
    if (found) {
      const post_url = `https://www.instagram.com/reel/${found.code}/`;
      rec = {
        ...rec,
        phase: "done",
        post_url,
        media_id: found.id,
        updated_at: new Date().toISOString(),
      };
      await kv.set(recKey(chain_id), rec);
      await saveState();
      return { ok: true, post_url, media_id: found.id, phase: "done" };
    }
  }

  if (priorAttempts >= MAX_CONFIGURE_ATTEMPTS) {
    throw new Error(
      `configure ambiguous after ${MAX_CONFIGURE_ATTEMPTS} attempts with no published media found — human review needed (no duplicate was posted)`
    );
  }

  // (4) Atomic post-slot reservation immediately BEFORE configure — max
  // 4/day + 3h spacing, CAS-guarded. This IS the increment, so no concurrent
  // chain can slip between check and publish. A failed configure afterwards
  // conservatively consumes the slot (safe direction: the cap can
  // under-fill, never over-fill). It runs after reconciliation so a retry
  // pump that finds an already-published reel never burns a slot.
  const slot = await tryReservePostSlot(device_id);
  if (!slot.ok) {
    // Park without consuming a chain attempt; a later pump retries.
    // Spacing self-heals after 3h; the cap self-heals at UTC midnight.
    throw new RetryableError(`post slot unavailable: ${slot.reason}`);
  }

  const attemptNo = priorAttempts + 1;
  let res: any;
  try {
    res = await ig.media.configureVideo({
      upload_id: rec.upload_id,
      caption,
      length: durationS,
      width: rec.width,
      height: rec.height,
      clips: [{ length: durationS, source_type: "4" }],
    });
  } catch (e: any) {
    // Ambiguous: the publish may or may not have happened (lost response).
    // Record the attempt and park — the NEXT pump reconciles before any
    // retry, so a duplicate is never published blindly.
    rec.configure_attempts = attemptNo;
    rec.updated_at = new Date().toISOString();
    await kv.set(recKey(chain_id), rec);
    await saveState();
    if (isInst(e, errors, "IgResponseError")) {
      const wrapped = new Error(`configure failed: ${e.message}`);
      (wrapped as any).response = e.response;
      Object.setPrototypeOf(wrapped, Object.getPrototypeOf(e));
      throw wrapped;
    }
    throw e;
  }
  const code: string | undefined = res?.media?.code;
  const mediaId: string | undefined = res?.media?.id;
  if (!code) {
    // Ambiguous: configure may or may not have published. Record the
    // attempt and park as retryable — the next pump reconciles first.
    rec.configure_attempts = attemptNo;
    rec.updated_at = new Date().toISOString();
    await kv.set(recKey(chain_id), rec);
    await saveState();
    throw new RetryableError(
      `configure returned no media code (attempt ${attemptNo}/${MAX_CONFIGURE_ATTEMPTS}) — recorded; next pump reconciles before any retry`
    );
  }
  const post_url = `https://www.instagram.com/reel/${code}/`;
  rec = { ...rec, phase: "done", post_url, media_id: mediaId, updated_at: new Date().toISOString() };
  await kv.set(recKey(chain_id), rec);
  await saveState();
  return { ok: true, post_url, media_id: mediaId, phase: "done" };
}
