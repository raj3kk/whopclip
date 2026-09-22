import { NextRequest, NextResponse } from "next/server";
import { getDevice } from "@/lib/store";

/**
 * POST /api/frames — device frame upload (multipart/form-data).
 * Fields: device_id, job_id, key, frame (PNG file).
 *
 * The phone's JobEngine captures WebView screenshots during verify stages
 * and uploads them here. The route:
 *  1. verifies the device is registered/paired,
 *  2. ensures the `whopclip` storage bucket exists (self-healing),
 *  3. stores the PNG under frames/<device_id>/<job_id>/<key>.png,
 *  4. returns { url } (public URL) for the dashboard / verify pipeline.
 *
 * Auth: device must be registered (paired). Frame uploads are keyed to the
 * device_id in the form, which must match a known device.
 */
export const dynamic = "force-dynamic";

const SB_URL =
  process.env.SUPABASE_URL ?? "https://lqvijxfbneqdrjzeeinn.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = "whopclip";

async function ensureBucket(): Promise<void> {
  // Check the bucket exists; create it (public) if not.
  const check = await fetch(`${SB_URL}/storage/v1/bucket/${BUCKET}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
    },
  });
  if (check.status === 200) return;
  const create = await fetch(`${SB_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (create.status !== 200 && create.status !== 201) {
    const text = await create.text().catch(() => "");
    throw new Error(`bucket create failed: ${create.status} ${text.slice(0, 200)}`);
  }
}

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "x";
}

export async function POST(req: NextRequest) {
  if (!SB_KEY) {
    return NextResponse.json(
      { error: "storage not configured" },
      { status: 503 }
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "multipart body required" }, { status: 400 });
  }

  const device_id = String(form.get("device_id") ?? "");
  const job_id = String(form.get("job_id") ?? "");
  const key = String(form.get("key") ?? "");
  const file = form.get("frame");

  if (!device_id || !job_id || !key || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: "device_id, job_id, key, frame required" },
      { status: 400 }
    );
  }
  if (file.size === 0 || file.size > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "frame empty or too large" }, { status: 400 });
  }

  const device = await getDevice(device_id);
  if (!device) {
    return NextResponse.json({ error: "unknown device" }, { status: 403 });
  }

  try {
    await ensureBucket();
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "bucket init failed" },
      { status: 500 }
    );
  }

  const objectPath = `frames/${safeSegment(device_id)}/${safeSegment(job_id)}/${safeSegment(key)}.png`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const upload = await fetch(
    `${SB_URL}/storage/v1/object/${BUCKET}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "image/png",
        "x-upsert": "true",
      },
      body: bytes,
    }
  );
  if (upload.status !== 200 && upload.status !== 201) {
    const text = await upload.text().catch(() => "");
    return NextResponse.json(
      { error: `upload failed: ${upload.status} ${text.slice(0, 200)}` },
      { status: 502 }
    );
  }

  const url = `${SB_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  return NextResponse.json({ ok: true, url, path: objectPath });
}
