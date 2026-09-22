import { NextRequest, NextResponse } from "next/server";
import { finishRender, getRender } from "@/lib/render";
import { onRenderDone } from "@/lib/chain";

/**
 * POST /api/render/result { id, ok, video_url?, error? }
 * VM worker reports a finished render. Auth: CRON_SECRET (x-cron-secret/Bearer).
 */
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return !!given && given === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const { id, ok, video_url, error } = body ?? {};
    if (!id || typeof ok !== "boolean") {
      return NextResponse.json(
        { error: "id and ok required" },
        { status: 400 }
      );
    }
    const existing = await getRender(String(id));
    if (!existing) {
      return NextResponse.json({ error: "render not found" }, { status: 404 });
    }
    if (ok && !video_url) {
      return NextResponse.json(
        { error: "video_url required when ok=true" },
        { status: 400 }
      );
    }
    const spec = await finishRender(
      String(id),
      ok,
      typeof video_url === "string" ? video_url : undefined,
      typeof error === "string" ? error : undefined
    );
    // Chain engine: a finished render advances the campaign pipeline
    // (render -> post). Never break the worker's result reporting.
    try {
      await onRenderDone(
        String(id),
        ok,
        typeof video_url === "string" ? video_url : undefined
      );
    } catch (e: unknown) {
      console.error("[chain] render advance error:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ ok: true, spec });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
