import { NextRequest, NextResponse } from "next/server";
import { decryptSession } from "@/lib/crypto";
import { getSession, type ServiceName } from "@/lib/store";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET /api/sessions/view?device_id=...[&service=whop|instagram]
 *
 * Owner auth (login cookie) OR x-cron-secret (SESSION_CHECK_SECRET) required.
 * Returns METADATA about the saved login sessions so the dashboard can show
 * cookies category-wise (Instagram / Whop / Content Rewards):
 *   - cookie names grouped by capture domain
 *   - masked value preview (first 3 + … + last 3 chars) — NEVER full values
 *   - JWT expiry info for JWT-looking cookies (exp/expired, claims scrubbed)
 *   - linked / stale / updated_at per service
 *
 * Raw cookie values are never returned by this route.
 */

function authed(req: NextRequest): boolean {
  if (verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) return true;
  const s = process.env.SESSION_CHECK_SECRET;
  return !!s && req.headers.get("x-cron-secret") === s;
}

/** Mask a cookie value: keep first/last 3 chars, hide the middle. */
function mask(v: string): string {
  if (v.length <= 8) return "•".repeat(Math.max(v.length, 4));
  return `${v.slice(0, 3)}…${v.slice(-3)}`;
}

function jwtExp(v: string): { exp: string; expired: boolean } | null {
  try {
    if (v.split(".").length !== 3) return null;
    const p = JSON.parse(Buffer.from(v.split(".")[1], "base64").toString()) as { exp?: number };
    if (typeof p.exp !== "number") return null;
    return {
      exp: new Date(p.exp * 1000).toISOString(),
      expired: p.exp * 1000 < Date.now(),
    };
  } catch {
    return null;
  }
}

type CookieMeta = {
  name: string;
  preview: string;
  length: number;
  jwt: { exp: string; expired: boolean } | null;
  looks_expired_jwt: boolean;
};

type Category = {
  key: string;
  title: string;
  domain: string;
  cookies: CookieMeta[];
};

function categorize(
  name: string,
  domain: string | undefined,
  service: ServiceName
): { key: string; title: string } {
  const d = (domain ?? "").toLowerCase();
  const n = name.toLowerCase();
  if (service === "instagram" || d.includes("instagram.com")) {
    return { key: "instagram", title: "📸 Instagram" };
  }
  if (d.includes("contentrewards.com")) {
    return { key: "contentrewards", title: "🎁 Content Rewards" };
  }
  if (
    d.includes("whop.com") ||
    n.startsWith("whop-core.") ||
    n.startsWith("__secure-whop") ||
    n.startsWith("__host-whop") ||
    n === "_whop_ssk" ||
    n.includes("next-auth.session-token") ||
    n.includes("authjs.session-token")
  ) {
    return { key: "whop", title: "🛍️ Whop" };
  }
  return { key: "other", title: "❓ Other (domain unknown)" };
}

export async function GET(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const q = new URL(req.url).searchParams;
  const device_id = q.get("device_id") ?? "";
  const only = q.get("service") ?? "";
  if (!device_id || (only && only !== "whop" && only !== "instagram")) {
    return NextResponse.json(
      { error: "device_id required; service must be whop|instagram" },
      { status: 400 }
    );
  }
  const services = (only ? [only] : ["whop", "instagram"]) as ServiceName[];
  const out: Record<string, unknown> = { device_id, services: {} as Record<string, unknown> };

  for (const svc of services) {
    const s = await getSession(device_id, svc);
    if (!s) {
      (out.services as Record<string, unknown>)[svc] = { linked: false };
      continue;
    }
    let jar: Record<string, string> = {};
    try {
      jar = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
    } catch {
      jar = {};
    }
    const domains = s.cookie_domains ?? {};
    const cats = new Map<string, Category>();
    for (const [name, value] of Object.entries(jar)) {
      const v = String(value ?? "");
      const { key, title } = categorize(name, domains[name], svc);
      if (!cats.has(key)) {
        cats.set(key, {
          key,
          title,
          domain: domains[name] ?? "",
          cookies: [],
        });
      }
      const j = jwtExp(v);
      cats.get(key)!.cookies.push({
        name,
        preview: mask(v),
        length: v.length,
        jwt: j,
        looks_expired_jwt: j?.expired ?? false,
      });
    }
    const categories = [...cats.values()].map((c) => ({
      ...c,
      cookies: c.cookies.sort((a, b) => a.name.localeCompare(b.name)),
    }));
    (out.services as Record<string, unknown>)[svc] = {
      linked: true,
      stale: s.stale === true,
      account: s.account ?? "",
      updated_at: s.updated_at ?? "",
      total_cookies: Object.keys(jar).length,
      categories,
    };
  }
  return NextResponse.json(out);
}
