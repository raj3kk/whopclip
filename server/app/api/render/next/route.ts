import { NextRequest, NextResponse } from "next/server";
import { claimRender } from "@/lib/render";

/**
 * GET /api/render/next — VM render worker polls this to claim the oldest
 * queued render spec. Auth: x-cron-secret header or Bearer (same CRON_SECRET
 * as the schedule tick). Returns { spec } or 204 when empty.
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

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const spec = await claimRender();
  if (!spec) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ spec });
}
