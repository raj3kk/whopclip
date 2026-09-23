import { NextRequest, NextResponse } from "next/server";
import { encryptSession, decryptSession } from "@/lib/crypto";
import { saveSession, getSession, type ServiceName } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET /api/sessions?device_id=...&service=whop|instagram
 * Owner login required. Returns the DECRYPTED cookies so the server/
 * dashboard can read and use the saved login session (automation,
 * debugging). Never expose this without owner auth.
 */
export async function GET(req: NextRequest) {
  if (!verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const device_id = req.nextUrl.searchParams.get("device_id") ?? "";
  const service = req.nextUrl.searchParams.get("service") ?? "";
  if (!device_id || (service !== "whop" && service !== "instagram")) {
    return NextResponse.json(
      { error: "device_id and service=whop|instagram required" },
      { status: 400 }
    );
  }
  const s = await getSession(device_id, service as ServiceName);
  if (!s) return NextResponse.json({ error: "no session saved" }, { status: 404 });
  let cookies: unknown = null;
  try {
    cookies = JSON.parse(decryptSession(s.encrypted));
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "decrypt failed" },
      { status: 500 }
    );
  }
  const names = cookies && typeof cookies === "object" ? Object.keys(cookies) : [];
  return NextResponse.json({
    device_id,
    service,
    account: s.account ?? "",
    stale: s.stale,
    updated_at: s.updated_at,
    cookie_names: names,
    cookies,
  });
}

/**
 * POST /api/sessions
 * Body: { device_id, service: "whop"|"instagram", cookies: {...}, user_agent, device_model }
 * Stores the login session AES-256-GCM encrypted.
 *
 * MERGE semantics (2026-09-23): incoming cookies are merged into the existing
 * jar for this device+service instead of replacing it. The phone uploads
 * whop.com cookies (LoginActivity) and contentrewards.com cookies (Browser tab)
 * separately — both are needed and must coexist in the one "whop" session the
 * server-side Content Rewards client reads.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { device_id, service, cookies, user_agent, device_model, account, domains } = body ?? {};
    if (!device_id || (service !== "whop" && service !== "instagram") || !cookies) {
      return NextResponse.json({ error: "device_id, service, cookies required" }, { status: 400 });
    }
    const existing = await getSession(device_id, service as ServiceName);
    let merged: Record<string, string> = {};
    let mergedDomains: Record<string, string> = {};
    if (existing) {
      try {
        merged = JSON.parse(decryptSession(existing.encrypted)) as Record<string, string>;
      } catch {
        merged = {};
      }
      mergedDomains = { ...(existing.cookie_domains ?? {}) };
    }
    for (const [k, v] of Object.entries(cookies as Record<string, unknown>)) {
      if (k && typeof v === "string" && v !== "") merged[k] = v;
    }
    // v20+: optional per-cookie capture domains (name -> domain) for the
    // category-wise Sessions view. Only non-empty string values accepted.
    if (domains && typeof domains === "object") {
      for (const [k, v] of Object.entries(domains as Record<string, unknown>)) {
        if (k && typeof v === "string" && v !== "") mergedDomains[k] = v.slice(0, 64);
      }
    }
    const encrypted = encryptSession(JSON.stringify(merged));
    const now = new Date().toISOString();
    await saveSession({
      device_id,
      service: service as ServiceName,
      encrypted,
      account: typeof account === "string" ? account.slice(0, 80) : (existing?.account ?? ""),
      user_agent: user_agent ?? (existing?.user_agent ?? ""),
      device_model: device_model ?? (existing?.device_model ?? ""),
      stale: false,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      cookie_domains: mergedDomains,
    });
    return NextResponse.json({ ok: true, service, merged_cookie_count: Object.keys(merged).length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
