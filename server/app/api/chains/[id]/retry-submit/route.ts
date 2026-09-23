import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { retryChainSubmit, pumpChain } from "@/lib/chain";

/**
 * POST /api/chains/[id]/retry-submit
 * Owner auth cookie OR x-cron-secret matching SESSION_CHECK_SECRET (the
 * agent's own automation path — the browser task cannot issue raw POSTs, so
 * the agent calls this directly). Resurrects a chain that failed at submit
 * (e.g. after the Whop session was refreshed in the app) and pumps it again.
 */
function authorized(req: NextRequest): boolean {
  if (verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) return true;
  const secret = process.env.SESSION_CHECK_SECRET || "";
  const header = req.headers.get("x-cron-secret") || "";
  return !!secret && header === secret;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const chain = await retryChainSubmit(params.id);
  if (!chain) return NextResponse.json({ error: "chain not found" }, { status: 404 });
  const pumped = await pumpChain(chain);
  return NextResponse.json({ ok: true, chain: pumped });
}
