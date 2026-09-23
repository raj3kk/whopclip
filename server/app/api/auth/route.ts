import { NextRequest, NextResponse } from "next/server";
import {
  authCookieHeader,
  checkPassword,
  clearAuthCookieHeader,
  anyPasswordSet,
} from "@/lib/auth";

/**
 * POST /api/auth { password } -> owner login, sets httpOnly cookie
 * DELETE /api/auth -> logout
 */
export async function POST(req: NextRequest) {
  if (!anyPasswordSet()) {
    return NextResponse.json(
      { error: "No owner credential set on server — see /login setup" },
      { status: 503 }
    );
  }
  try {
    const body = await req.json();
    const password = typeof body?.password === "string" ? body.password : "";
    if (!checkPassword(password)) {
      return NextResponse.json({ error: "wrong password" }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    res.headers.set("Set-Cookie", authCookieHeader());
    return res;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearAuthCookieHeader());
  return res;
}
