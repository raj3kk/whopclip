import { NextRequest, NextResponse } from "next/server";
import { getChain } from "@/lib/chain";
import { getDevice, deviceOnline, enqueueJob } from "@/lib/store";
import { igPostJob } from "@/lib/jobs";

/**
 * POST /api/chains/[id]/enqueue-post
 *
 * Directly enqueue the ig_post phone job for a chain parked at the post
 * stage. Bypasses the full pump (which scans all campaigns and can time
 * out). Idempotent: if a phone job is already queued/running, returns it.
 *
 * Body: { device_id }
 *
 * Auth: device_id possession (same model as /api/chains/advance).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const chainId = params.id;
  let body: { device_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const device_id = body.device_id ?? "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }

  const chain = await getChain(chainId);
  if (!chain) {
    return NextResponse.json({ error: "chain not found" }, { status: 404 });
  }
  if (chain.device_id !== device_id) {
    return NextResponse.json({ error: "device mismatch" }, { status: 403 });
  }
  if (chain.status !== "active") {
    return NextResponse.json(
      { error: `chain not active (status: ${chain.status})` },
      { status: 400 }
    );
  }
  if (chain.stage !== "post") {
    return NextResponse.json(
      { error: `chain not at post stage (stage: ${chain.stage})` },
      { status: 400 }
    );
  }
  if (chain.ig_post_url) {
    return NextResponse.json(
      { error: "chain already posted", ig_post_url: chain.ig_post_url },
      { status: 400 }
    );
  }
  if (!chain.video_url || !chain.caption) {
    return NextResponse.json(
      { error: "chain missing video_url or caption" },
      { status: 400 }
    );
  }

  // If a phone job is already in flight, return it (idempotent).
  if (chain.phone_job_id) {
    const { getJob } = await import("@/lib/store");
    const pj = await getJob(chain.phone_job_id);
    if (pj && (pj.status === "queued" || pj.status === "running")) {
      return NextResponse.json({
        ok: true,
        job_id: pj.id,
        status: pj.status,
        note: "job already in flight",
      });
    }
  }

  // Phone must be online.
  const device = await getDevice(device_id);
  if (!device || !deviceOnline(device)) {
    return NextResponse.json(
      { error: "phone offline — chain parked, will enqueue on next poll" },
      { status: 409 }
    );
  }

  // Enqueue the ig_post job.
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    device_id,
    type: "ig_post",
    status: "queued" as const,
    steps: igPostJob({ caption: chain.caption }),
    payload: {
      video_url: chain.video_url,
      chain_id: chain.id,
      campaign_id: chain.campaign_id,
    },
    campaign_id: chain.campaign_id,
    result: null,
    created_at: now,
    updated_at: now,
  };
  await enqueueJob(job);

  // Update the chain.
  const c = (await getChain(chainId))!;
  c.phone_job_id = job.id;
  c.error = `phone upload job queued (${job.id.slice(0, 8)}) — waiting for phone to pick it up`;
  c.updated_at = now;
  const { kv } = await import("@/lib/store");
  await kv.set(`chain:${c.id}`, c);

  return NextResponse.json({
    ok: true,
    job_id: job.id,
    status: "queued",
    note: "ig_post job enqueued, phone will claim on next poll",
  });
}
