import { NextRequest, NextResponse } from "next/server";
import { pumpDeviceChains } from "@/lib/chain";
import { touchDevice } from "@/lib/store";

/**
 * GET /api/chains/advance?device_id=...
 *
 * Pump every active chain for this device one full pass through all
 * runnable stages (check/join/post/verify/submit; render parks on the VM
 * worker). Idempotent — safe to call repeatedly.
 *
 * Called by:
 *   - the phone's PollWorker on every poll (retry driver for long stages;
 *     Vercel Hobby allows only one cron/day, so the phone poll drives
 *     retries),
 *   - the dashboard "▶ Pump chains" button (owner login, same effect).
 *
 * Auth: device_id possession (same model as /api/jobs/next). The route
 * only advances chains owned by that device_id; it never touches another
 * device's chains.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  if (!device_id) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }
  try {
    // The phone is clearly online (it's calling us) — touch last_poll_at
    // BEFORE pumping so the hybrid post stage sees it as online and
    // enqueues the ig_post job in this same pass (no 15-min delay).
    await touchDevice(device_id).catch(() => {});
    const chains = await pumpDeviceChains(device_id);
    return NextResponse.json({
      ok: true,
      device_id,
      chains: chains.map((c) => ({
        id: c.id,
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        stage: c.stage,
        status: c.status,
        attempts: c.attempts,
        error: c.error,
        ig_post_url: c.ig_post_url,
        updated_at: c.updated_at,
      })),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "pump failed" },
      { status: 500 }
    );
  }
}
