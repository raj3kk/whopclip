import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { markChainVerified, pumpChain } from "@/lib/chain";

/**
 * POST /api/chains/[id]/mark-verified
 * Owner auth. Records that the live reel was verified in-browser
 * (URL live, caption/tags exact, 9:16 uncropped) and advances the
 * chain to submit. Used when Instagram blocks the server-side
 * HTML scrape from datacenter IPs.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const chain = await markChainVerified(params.id);
  if (!chain) return NextResponse.json({ error: "chain not found" }, { status: 404 });
  const pumped = await pumpChain(chain);
  return NextResponse.json({ ok: true, chain: pumped });
}
