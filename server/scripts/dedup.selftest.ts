/**
 * Self-test for render variant deduplication (lib/render.ts).
 *
 * Run (from server/):
 *   ./node_modules/.bin/tsc scripts/dedup.selftest.ts --outDir /tmp/dedup-selftest \
 *     --module commonjs --target es2022 --moduleResolution node \
 *     --esModuleInterop --skipLibCheck --strict
 *   node --test /tmp/dedup-selftest/scripts/dedup.selftest.js
 *
 * Uses the in-memory KV fallback — set NO supabase/turso env keys so the
 * test never touches the real store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRenderSpec,
  enqueueRender,
  enqueueRenderDedup,
  finishRender,
  getReusableRender,
  variantKeyFor,
} from "../lib/render";
import { kv } from "../lib/store";
import type { Campaign, Requirements } from "../lib/store";

const req = (caption = "Caption #tag"): Requirements => ({
  video_max_duration_s: 30,
  aspect: "9:16",
  captions_required: true,
  caption_template: caption,
  required_mentions: ["@x"],
  required_hashtags: ["#tag"],
  posting_rules: [],
  payout_per_1k: 2,
});

const camp = (id: string, name = "Camp"): Campaign => ({
  id,
  name,
  whop_url: "https://whop.com/c",
  active: true,
  budget_remaining: 100,
  payout_per_1k: 2,
  joined: true,
  requirements: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const specFor = (campaignId: string, hook = "Hook text here", device = "dev1") =>
  buildRenderSpec(device, camp(campaignId), req(), {
    authorized_sources: ["https://example.com/src.mp4"],
    title_templates: [hook],
  });

const queueLen = async () =>
  (((await kv.get("render_queue")) as string[] | null) ?? []).length;

test("variantKeyFor: deterministic, trimmed, 64-hex sha256", () => {
  const a = variantKeyFor({
    campaign_id: "c1",
    authorized_source: "src",
    hook_text: "hook",
    caption: "cap",
  });
  const b = variantKeyFor({
    campaign_id: " c1 ",
    authorized_source: "src\n",
    hook_text: " hook ",
    caption: " cap ",
  });
  assert.equal(a, b, "whitespace-trimmed inputs must hash identically");
  assert.match(a, /^[0-9a-f]{64}$/);
  const c = variantKeyFor({
    campaign_id: "c2",
    authorized_source: "src",
    hook_text: "hook",
    caption: "cap",
  });
  assert.notEqual(a, c, "different campaign must hash differently");
});

test("buildRenderSpec sets variant_key", () => {
  const s = specFor("dedup-c-spec");
  assert.match(s.variant_key!, /^[0-9a-f]{64}$/);
  assert.equal(
    s.variant_key,
    variantKeyFor({
      campaign_id: s.campaign_id,
      authorized_source: s.authorized_source,
      hook_text: s.hook_text,
      caption: s.caption,
    })
  );
});

test("enqueueRenderDedup: first enqueue ok, duplicate returns existing", async () => {
  const q0 = await queueLen();
  const r1 = await enqueueRenderDedup(specFor("dedup-c-dup1"));
  assert.equal(r1.duplicate, false);
  const r2 = await enqueueRenderDedup(specFor("dedup-c-dup1"));
  assert.equal(r2.duplicate, true);
  assert.equal(r2.spec.id, r1.spec.id);
  assert.equal(await queueLen(), q0 + 1, "duplicate must not grow the queue");
  const idx = (await kv.get("render_variant_idx")) as Record<string, string>;
  assert.equal(idx[r1.spec.variant_key!], r1.spec.id);
});

test("enqueueRenderDedup: failed render allows re-enqueue + index overwrite", async () => {
  const r1 = await enqueueRenderDedup(specFor("dedup-c-fail1"));
  assert.equal(r1.duplicate, false);
  await finishRender(r1.spec.id, false, undefined, undefined, "worker exploded");
  const r2 = await enqueueRenderDedup(specFor("dedup-c-fail1"));
  assert.equal(r2.duplicate, false, "failed variant may be re-enqueued");
  assert.notEqual(r2.spec.id, r1.spec.id);
  const idx = (await kv.get("render_variant_idx")) as Record<string, string>;
  assert.equal(
    idx[r2.spec.variant_key!],
    r2.spec.id,
    "index overwritten with the new id"
  );
});

test("enqueueRenderDedup: claimed render counts as duplicate", async () => {
  const r1 = await enqueueRenderDedup(specFor("dedup-c-claim"));
  assert.equal(r1.duplicate, false);
  await kv.set(`render:${r1.spec.id}`, { ...r1.spec, status: "claimed" });
  const r2 = await enqueueRenderDedup(specFor("dedup-c-claim"));
  assert.equal(r2.duplicate, true);
  assert.equal(r2.spec.id, r1.spec.id);
});

test("enqueueRender stays back-compatible (delegates through dedup)", async () => {
  const s1 = await enqueueRender(specFor("dedup-c-legacy"));
  const s2 = await enqueueRender(specFor("dedup-c-legacy"));
  assert.equal(s2.id, s1.id, "legacy path must also dedup");
});

test("getReusableRender: newest done with video_url wins, any device", async () => {
  // v1: done WITH video -> candidate
  const v1 = await enqueueRenderDedup(specFor("dedup-c-reuse", "H1"));
  await finishRender(
    v1.spec.id,
    true,
    "https://cdn/x/v1.mp4",
    "https://cdn/x/c1.jpg"
  );
  // v2: done but NO video -> skipped
  const v2 = await enqueueRenderDedup(specFor("dedup-c-reuse", "H2"));
  await finishRender(v2.spec.id, true);
  // v3: different campaign, done with video -> not returned for this campaign
  const other = await enqueueRenderDedup(specFor("dedup-c-other", "H1"));
  await finishRender(
    other.spec.id,
    true,
    "https://cdn/x/other.mp4",
    "https://cdn/x/oc.jpg"
  );

  let best = await getReusableRender("dedup-c-reuse", "dev1");
  assert.ok(best, "expected a reusable render");
  assert.equal(best!.id, v1.spec.id);

  // v4: newer done with video on ANOTHER device -> wins over v1
  const v4 = await enqueueRenderDedup(specFor("dedup-c-reuse", "H3", "dev2"));
  const later = { ...v4.spec, created_at: new Date(Date.now() + 60_000).toISOString() };
  await kv.set(`render:${v4.spec.id}`, later);
  await finishRender(
    v4.spec.id,
    true,
    "https://cdn/x/v4.mp4",
    "https://cdn/x/c4.jpg"
  );
  best = await getReusableRender("dedup-c-reuse", "dev1");
  assert.ok(best, "expected a reusable render");
  assert.equal(best!.id, v4.spec.id, "newest done render must win");

  // campaign with no done renders -> null
  const none = await getReusableRender("dedup-c-missing");
  assert.equal(none, null);
});
