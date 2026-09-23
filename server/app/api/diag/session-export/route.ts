import { NextRequest, NextResponse } from "next/server";
import { decryptSession } from "@/lib/crypto";
import { getSession, type ServiceName } from "@/lib/store";

/**
 * TEMP DIAGNOSTIC — DELETE AFTER ONE-TIME WEBVIEW DEMO.
 *
 * GET /api/diag/session-export?device_id=...&service=whop
 * Auth: x-cron-secret header === process.env.CRON_SECRET (render-worker secret).
 * Returns the RAW decrypted cookie jar so a local Chromium can log in to
 * contentrewards.com exactly the way the phone WebView does, for a visual
 * login/submission-list demo. Values are returned in the response body only
 * and are never logged anywhere.
 */
export async function GET(req: NextRequest) {
  const s = process.env.CRON_SECRET;
  if (!s || req.headers.get("x-cron-secret") !== s) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const q = new URL(req.url).searchParams;
  const device_id = q.get("device_id") ?? "";
  const service = (q.get("service") ?? "whop") as ServiceName;
  if (!device_id || (service !== "whop" && service !== "instagram")) {
    return NextResponse.json(
      { error: "device_id required; service must be whop|instagram" },
      { status: 400 }
    );
  }
  const sess = await getSession(device_id, service);
  if (!sess) {
    return NextResponse.json({ error: "no session" }, { status: 404 });
  }
  let jar: Record<string, string> = {};
  try {
    jar = JSON.parse(decryptSession(sess.encrypted)) as Record<string, string>;
  } catch {
    jar = {};
  }
  const domains = (sess.cookie_domains ?? {}) as Record<string, string>;
  const cookies = Object.entries(jar).map(([name, value]) => ({
    name,
    value: String(value ?? ""),
    domain: domains[name] ?? "",
    path: "/",
  }));
  return NextResponse.json({
    device_id,
    service,
    count: cookies.length,
    cookies,
  });
}
