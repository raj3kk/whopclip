import { NextRequest, NextResponse } from "next/server";
import {
  claimPairCode,
  createPairCode,
  getPairCode,
  registerDevice,
} from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * Device pairing — links a phone app to this control plane.
 *
 * POST { action:"generate" }            (owner login) -> { code, expires_at }
 * GET  ?code=XXXX-XXXX                   (owner login) -> { claimed, device_id, expires_at }
 * POST { action:"claim", code, device_id, app_version?, device_model? }
 *                                        (phone, no login) -> { ok, device_id }
 *
 * The phone app shows a "pairing code" field on first launch; the owner
 * generates a code on /connect and reads it out / types it in.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === "generate") {
      if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
        return NextResponse.json({ error: "login required" }, { status: 401 });
      }
      const p = await createPairCode(10);
      return NextResponse.json({ code: p.code, expires_at: p.expires_at });
    }

    if (action === "claim") {
      const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
      const device_id = typeof body?.device_id === "string" ? body.device_id.trim() : "";
      if (!code || !device_id) {
        return NextResponse.json({ error: "code, device_id required" }, { status: 400 });
      }
      const p = await claimPairCode(code, device_id);
      if (!p) {
        return NextResponse.json(
          { error: "invalid or expired code" },
          { status: 404 }
        );
      }
      const now = new Date().toISOString();
      await registerDevice({
        device_id,
        paired_at: now,
        last_poll_at: now,
        app_version: typeof body?.app_version === "string" ? body.app_version : null,
        device_model: typeof body?.device_model === "string" ? body.device_model : null,
      });
      return NextResponse.json({ ok: true, device_id, claimed: p.claimed_by === device_id });
    }

    return NextResponse.json({ error: "action must be generate|claim" }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const p = await getPairCode(code);
  if (!p) return NextResponse.json({ error: "code not found" }, { status: 404 });
  return NextResponse.json({
    code: p.code,
    claimed: !!p.claimed_by,
    device_id: p.claimed_by,
    expires_at: p.expires_at,
  });
}
