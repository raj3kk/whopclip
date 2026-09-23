import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { markChainPosted, pumpChain } from "@/lib/chain";

/**
 * POST /api/chains/[id]/mark-posted
 * Body: { ig_post_url }
 * Owner auth. Records an externally-completed Instagram post and advances
 * the chain to verify. Used when the post was made through the
 * user-authorized browser flow (server API path blocked).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  let body: { ig_post_url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const url = (body?.ig_post_url ?? "").trim();
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "ig_post_url required" }, { status: 400 });
  }
  const chain = await markChainPosted(params.id, url);
  if (!chain) return NextResponse.json({ error: "chain not found" }, { status: 404 });
  const pumped = await pumpChain(chain);
  return NextResponse.json({ ok: true, chain: pumped });
}
