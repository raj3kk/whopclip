import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/store";

/**
 * GET /api/campaigns?device_id=...
 * v1: returns the campaign pipeline state for this device.
 * Campaign discovery (Whop Content Rewards list via stored session)
 * is implemented in the orchestrator step — this skeleton returns a
 * placeholder so the API contract is stable.
 */
export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id");
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  const whop = getSession(device_id, "whop");
  if (!whop) {
    return NextResponse.json({ error: "whop not linked" }, { status: 409 });
  }
  // TODO(orchestrator): use decrypted whop cookies to fetch
  // https://whop.com/content-rewards / experience campaigns, join state,
  // and requirements. For now the phone drives discovery via JobEngine.
  return NextResponse.json({
    device_id,
    campaigns: [],
    note: "campaign discovery not yet implemented server-side; use job queue to drive phone WebView",
  });
}
