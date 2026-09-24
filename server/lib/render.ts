import crypto from "crypto";
import type { Campaign, Requirements } from "./store";
import { kv } from "./store";

/**
 * WhopClip render pipeline — server/VM side.
 *
 * The phone cannot run ffmpeg/whisper, and Vercel serverless cannot hold a
 * render. So clip rendering happens on the operator VM:
 *
 *   server enqueues render spec  ->  VM worker polls /api/render/next
 *     -> downloads the AUTHORIZED source only (fail closed: no authorized
 *        source, no render) -> transcribes -> renders 9:16 with safe zones
 *        (hook >=10% from top, captions at/above 78%) -> uploads MP4 to
 *        Supabase storage -> POST /api/render/result { video_url }
 *   -> phone downloads video_url and posts to Instagram.
 *
 * WORKER COVER CONTRACT (fail-closed): the worker MUST also extract a REAL
 * cover frame from the rendered video (ffmpeg, e.g. `-ss 1 -frames:v 1`,
 * 720x1280 JPEG — a frame where the hook/title is visible), upload it as
 * cover.jpg next to the MP4, and include its public URL as `cover_url` in
 * the result. The post stage refuses to publish without a real cover —
 * no placeholder is ever generated server-side.
 */

export interface RenderSpec {
  id: string;
  device_id: string;
  campaign_id: string;
  campaign_name: string;
  /** exact authorized source (URL or @handle) — worker must use ONLY this */
  authorized_source: string;
  requirements: Requirements;
  title_templates: string[];
  /** chosen hook/title text for this render */
  hook_text: string;
  /** exact caption to burn into the post step */
  caption: string;
  /**
   * Dedup key: sha256 hex of "campaign_id|authorized_source|hook_text|caption"
   * (all trimmed). Set by buildRenderSpec / enqueueRenderDedup before storing.
   * Optional: specs persisted before the dedup rollout don't carry it.
   */
  variant_key?: string;
  status: "queued" | "claimed" | "done" | "failed";
  /** worker-side attempts (transient infra failures requeue, capped) */
  worker_attempts: number;
  video_url: string | null;
  /** real cover frame URL (ffmpeg-extracted source frame) — required when done */
  cover_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const renderKey = (id: string) => `render:${id}`;

async function getIdx(key: string): Promise<string[]> {
  const v = (await kv.get(key)) as unknown;
  return Array.isArray(v) ? (v as string[]) : [];
}

async function addToIdx(key: string, id: string) {
  const idx = await getIdx(key);
  if (!idx.includes(id)) {
    idx.push(id);
    await kv.set(key, idx);
  }
}

/**
 * Variant dedup key: sha256 hex of
 * "campaign_id|authorized_source|hook_text|caption" (all trimmed).
 * The same logical render (same campaign, source, hook, caption) always
 * hashes to the same key regardless of its random render id.
 */
export function variantKeyFor(parts: {
  campaign_id: string;
  authorized_source: string;
  hook_text: string;
  caption: string;
}): string {
  const s = [
    parts.campaign_id,
    parts.authorized_source,
    parts.hook_text,
    parts.caption,
  ]
    .map((x) => String(x ?? "").trim())
    .join("|");
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Dedup index: variant_key -> render_id (the latest render for that key). */
const VARIANT_IDX = "render_variant_idx";

async function getVariantIdx(): Promise<Record<string, string>> {
  const v = (await kv.get(VARIANT_IDX)) as unknown;
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, string>)
    : {};
}

async function setVariantIdx(idx: Record<string, string>): Promise<void> {
  await kv.set(VARIANT_IDX, idx);
}

/**
 * Build a render spec from a campaign + extracted requirements.
 * FAIL-CLOSED: throws when there is no authorized source or no caption.
 */
export function buildRenderSpec(
  device_id: string,
  campaign: Campaign,
  requirements: Requirements,
  opts: { authorized_sources: string[]; title_templates: string[] }
): RenderSpec {
  const source = opts.authorized_sources[0];
  if (!source) {
    throw new Error(
      `render blocked: campaign "${campaign.name}" has no authorized source`
    );
  }
  const caption = requirements.caption_template;
  if (!caption) {
    throw new Error(
      `render blocked: campaign "${campaign.name}" has no caption template`
    );
  }
  const hook =
    opts.title_templates[0] ??
    campaign.name ??
    "Watch this";
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    device_id,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    authorized_source: source,
    requirements,
    title_templates: opts.title_templates,
    hook_text: hook,
    caption,
    variant_key: variantKeyFor({
      campaign_id: campaign.id,
      authorized_source: source,
      hook_text: hook,
      caption,
    }),
    status: "queued",
    worker_attempts: 0,
    video_url: null,
    cover_url: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Enqueue a render spec with server-side variant deduplication.
 *
 * If a render with the same variant_key already exists with status
 * done/claimed/queued, the EXISTING spec is returned with duplicate=true
 * and nothing is enqueued. A `failed` existing render allows re-enqueue:
 * the index is overwritten with the new id and the new spec is enqueued
 * normally (duplicate=false).
 */
export async function enqueueRenderDedup(
  spec: RenderSpec
): Promise<{ spec: RenderSpec; duplicate: boolean }> {
  if (!spec.variant_key) {
    spec.variant_key = variantKeyFor({
      campaign_id: spec.campaign_id,
      authorized_source: spec.authorized_source,
      hook_text: spec.hook_text,
      caption: spec.caption,
    });
  }
  const idx = await getVariantIdx();
  const existingId = idx[spec.variant_key];
  if (existingId) {
    const existing = await getRender(existingId);
    if (
      existing &&
      (existing.status === "done" ||
        existing.status === "claimed" ||
        existing.status === "queued")
    ) {
      // Same logical render already in flight or finished — never render twice.
      return { spec: existing, duplicate: true };
    }
    // existing is failed or the row vanished: fall through and re-enqueue.
  }
  idx[spec.variant_key] = spec.id;
  await setVariantIdx(idx);
  await kv.set(renderKey(spec.id), spec);
  await addToIdx("render_queue", spec.id);
  await addToIdx(`render_queue:${spec.device_id}`, spec.id);
  return { spec, duplicate: false };
}

export async function enqueueRender(spec: RenderSpec): Promise<RenderSpec> {
  const { spec: s } = await enqueueRenderDedup(spec);
  return s;
}

export async function getRender(id: string): Promise<RenderSpec | null> {
  const v = (await kv.get(renderKey(id))) as unknown;
  return (v as RenderSpec) ?? null;
}

/** VM worker claims the oldest queued render spec (single-flight). */
export async function claimRender(): Promise<RenderSpec | null> {
  const ids = await getIdx("render_queue");
  for (const id of ids) {
    const spec = await getRender(id);
    if (!spec || spec.status !== "queued") continue;
    spec.status = "claimed";
    spec.updated_at = new Date().toISOString();
    await kv.set(renderKey(id), spec);
    return spec;
  }
  return null;
}

/**
 * Requeue a spec after a TRANSIENT worker failure (network blip, timeout).
 * The VM worker's 5-min cron picks it up again. Capped: caller must check
 * worker_attempts before calling.
 */
export async function requeueRender(id: string, error: string): Promise<RenderSpec | null> {
  const spec = await getRender(id);
  if (!spec) return null;
  spec.status = "queued";
  spec.worker_attempts = (spec.worker_attempts ?? 0) + 1;
  spec.error = error;
  spec.updated_at = new Date().toISOString();
  await kv.set(renderKey(id), spec);
  return spec;
}

const TRANSIENT_RENDER_ERROR = /timeout|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|Remote end closed|IncompleteRead|connection (reset|closed|refused|aborted)|network unreachable|temporary failure/i;

/** True when a worker error looks like transient infra (safe to requeue). */
export function isTransientRenderError(error: string): boolean {
  return TRANSIENT_RENDER_ERROR.test(error || "");
}

export async function finishRender(
  id: string,
  ok: boolean,
  video_url?: string,
  cover_url?: string,
  error?: string
): Promise<RenderSpec | null> {
  const spec = await getRender(id);
  if (!spec) return null;
  spec.status = ok ? "done" : "failed";
  spec.video_url = video_url ?? null;
  spec.cover_url = cover_url ?? null;
  spec.error = error ?? null;
  spec.updated_at = new Date().toISOString();
  await kv.set(renderKey(id), spec);
  return spec;
}

export async function listRenders(device_id?: string): Promise<RenderSpec[]> {
  const ids = await getIdx(device_id ? `render_queue:${device_id}` : "render_queue");
  const out: RenderSpec[] = [];
  for (const id of ids) {
    const s = await getRender(id);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Round-robin reuse: returns the newest `done` render for the campaign that
 * has a video_url (any device), or null when there is none. Lets chains
 * reuse an already-rendered video instead of queueing a fresh render.
 */
export async function getReusableRender(
  campaign_id: string,
  _device_id?: string
): Promise<RenderSpec | null> {
  const ids = await getIdx("render_queue");
  let best: RenderSpec | null = null;
  for (const id of ids) {
    const s = await getRender(id);
    if (!s || s.campaign_id !== campaign_id) continue;
    if (s.status !== "done" || !s.video_url) continue;
    if (!best || s.created_at > best.created_at) best = s;
  }
  return best;
}
