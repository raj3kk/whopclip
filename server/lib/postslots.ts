/**
 * Atomic daily post-slot reservation for Instagram uploads.
 *
 * Standing user policy:
 *   - max 4 published posts per device per UTC day
 *   - minimum 3h spacing between posts
 *
 * Key layout: `postslots:<device_id>:<UTC-date>` -> { count, last_post_at }
 * (a fresh key each UTC day, so the count resets naturally).
 *
 * Correctness note: the reservation is a single CAS (check + increment
 * atomically), performed immediately BEFORE `configure` — the true point of
 * no return — inside the igpost phase machine. An "increment after success"
 * design would leave a TOCTOU window where two chains both pass the check,
 * both publish, then both increment (5 posts). So the reservation IS the
 * increment. A configure that fails afterwards conservatively consumes its
 * slot (safe direction: the cap can under-fill, never over-fill).
 *
 * Read-only `getPostSlots` is for early checks (chain start refuses when the
 * day's cap is already reached). Spacing is enforced only at reservation
 * time, because a chain started hours before its post must not be refused
 * for a gap that will have elapsed by post time.
 */
import { getWithTs, casKey, kv } from "./store";

export const MAX_POSTS_PER_DAY = 4;
export const MIN_POST_SPACING_MS = 3 * 60 * 60 * 1000;

export interface PostSlots {
  count: number;
  last_post_at: string | null;
}

const slotKey = (device_id: string, date = new Date().toISOString().slice(0, 10)) =>
  `postslots:${device_id}:${date}`;

const EMPTY: PostSlots = { count: 0, last_post_at: null };

function coerce(v: unknown): PostSlots {
  if (!v || typeof v !== "object") return { ...EMPTY };
  const o = v as Record<string, unknown>;
  return {
    count: typeof o.count === "number" && o.count >= 0 ? Math.floor(o.count) : 0,
    last_post_at: typeof o.last_post_at === "string" ? o.last_post_at : null,
  };
}

/** Read-only view of today's slots. NOT a reservation — for early checks. */
export async function getPostSlots(device_id: string): Promise<PostSlots> {
  try {
    return coerce(await kv.get(slotKey(device_id)));
  } catch {
    return { ...EMPTY };
  }
}

function spacingWaitMs(s: PostSlots, now: number): number {
  if (!s.last_post_at) return 0;
  const last = new Date(s.last_post_at).getTime();
  if (!isFinite(last)) return 0;
  return MIN_POST_SPACING_MS - (now - last);
}

/**
 * Atomically reserve one post slot for this device, right now.
 * Returns { ok: true } only when this caller won the CAS.
 * Returns { ok: false, reason } when the cap/spacing forbids it, or when
 * contention could not be resolved — the caller must NOT publish.
 */
export async function tryReservePostSlot(
  device_id: string
): Promise<{ ok: boolean; reason?: string }> {
  const key = slotKey(device_id);
  for (let i = 0; i < 4; i++) {
    const now = Date.now();
    const row = await getWithTs(key);
    const cur = coerce(row?.value);
    if (cur.count >= MAX_POSTS_PER_DAY) {
      return {
        ok: false,
        reason: `daily post cap reached (${cur.count}/${MAX_POSTS_PER_DAY})`,
      };
    }
    const waitMs = spacingWaitMs(cur, now);
    if (waitMs > 0) {
      const mins = Math.ceil(waitMs / 60000);
      return {
        ok: false,
        reason: `post spacing: last post too recent — wait ~${mins} min`,
      };
    }
    const next: PostSlots = {
      count: cur.count + 1,
      last_post_at: new Date(now).toISOString(),
    };
    if (!row) {
      // First reservation of the day: seed the row, then CAS on the re-read.
      // Two concurrent seeders still serialize on the CAS below.
      await kv.set(key, { ...EMPTY });
      continue;
    }
    if (await casKey(key, next, row.updated_at)) return { ok: true };
    // Lost the race — re-read and re-evaluate (bounded).
  }
  return { ok: false, reason: "slot reservation contention — retry on next pump" };
}
