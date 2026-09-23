import { cookies } from "next/headers";
import { verifyAuthToken, AUTH_COOKIE } from "@/lib/auth";
import { getSession } from "@/lib/store";
import { whopCookieHeader, crFetch } from "@/lib/whop";
import { decryptSession } from "@/lib/crypto";

/**
 * TEMPORARY visual demo (user-requested 2026-09-23):
 * "session cookies se WebView login kaise hota hai + submission list"
 * Read-only. Renders live proof from the saved session:
 *   1. login kaise hota hai (cookie -> Cookie header -> 200)
 *   2. submission list (live)
 *   3. submit kaise hota hai (flow, no mutation)
 * Cookie VALUES are never rendered. Delete after demo.
 */
export const dynamic = "force-dynamic";

const KNOWN_DEVICE = "b5cce48d-cf27-4bcb-b9fe-3c0416ed71fc";

type Item = Record<string, unknown>;

function pick(o: Item): Item {
  const out: Item = {};
  for (const k of [
    "id", "campaignId", "campaign_id", "campaignName", "campaign_name",
    "status", "platform", "postUrl", "post_url", "postURL",
    "createdAt", "created_at", "state", "reviewStatus", "campaign",
  ]) {
    if (o[k] !== undefined && typeof o[k] !== "object") out[k] = o[k];
  }
  if (o.campaign && typeof o.campaign === "object") {
    const c = o.campaign as Item;
    for (const k of ["id", "name", "title"]) {
      if (typeof c[k] === "string" || typeof c[k] === "number") out[`campaign.${k}`] = c[k];
    }
  }
  return out;
}

function jwtExp(token: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString("utf8")
    ) as { exp?: number };
    if (payload.exp) return new Date(payload.exp * 1000).toISOString();
  } catch { /* ignore */ }
  return "unknown";
}

export default async function SessionLoginDemo({
  searchParams,
}: {
  searchParams: { device_id?: string };
}) {
  const authed = verifyAuthToken(cookies().get(AUTH_COOKIE)?.value);
  if (!authed) {
    return (
      <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 640 }}>
        <h1>🔐 Session Login Demo</h1>
        <p>
          Pehle <a href="/login">dashboard me login karo</a>, phir ye page kholo.
        </p>
      </main>
    );
  }

  const device_id = searchParams.device_id || KNOWN_DEVICE;
  const s = await getSession(device_id, "whop");
  if (!s) {
    return (
      <main style={{ fontFamily: "system-ui", padding: 32 }}>
        <h1>🔐 Session Login Demo</h1>
        <p>Is device ke liye koi saved session nahi mila.</p>
      </main>
    );
  }

  // Masked jar stats only — values never leave the server.
  const jar = JSON.parse(decryptSession(s.encrypted)) as Record<string, string>;
  const names = Object.keys(jar);
  const crNames = names.filter((n) => /cr-|_cr|contentreward/i.test(n) || n.startsWith("__Host-cr"));
  const accessToken = jar["__Host-cr-access-token"] || "";
  const tokenExp = accessToken ? jwtExp(accessToken) : "n/a";

  const cookieHeader = await whopCookieHeader(device_id);
  const ref = { cookieHeader, referer: "https://contentrewards.com/discover" };

  // 1) Login proof — the exact check the site itself does.
  let authStatus: number | null = null;
  let account = "";
  try {
    const r = await crFetch("/api/auth/authenticate/session", ref);
    authStatus = r.status;
    const t = await r.text().catch(() => "");
    try {
      const j = JSON.parse(t) as Item;
      const u = (j.user || j.account || j) as Item;
      account = String(u.email || u.id || u.whitelabelId || "");
    } catch { /* non-JSON */ }
  } catch { authStatus = -1; }

  // 2) Submission list (read-only).
  let subs: Item[] = [];
  let drafts = 0;
  try {
    const r = await crFetch("/api/submission/submissions?limit=50", ref);
    const t = await r.text().catch(() => "");
    try {
      const j = JSON.parse(t) as unknown;
      const arr = Array.isArray(j)
        ? j
        : j && typeof j === "object"
          ? ((j as Item).items || (j as Item).data || (j as Item).submissions || []) as unknown[]
          : [];
      subs = arr.filter((i) => i && typeof i === "object").map((i) => pick(i as Item));
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  try {
    const r = await crFetch("/api/submission/submission-drafts?limit=50", ref);
    const t = await r.text().catch(() => "");
    try {
      const j = JSON.parse(t) as unknown;
      const arr = Array.isArray(j) ? j : ((j as Item)?.items as unknown[]) || [];
      drafts = arr.length;
    } catch { /* ignore */ }
  } catch { /* ignore */ }

  const loggedIn = authStatus === 200;
  const card: React.CSSProperties = {
    border: "1px solid #ddd", borderRadius: 12, padding: 20, marginBottom: 20,
    background: "#fff",
  };
  const badge = (ok: boolean): React.CSSProperties => ({
    display: "inline-block", padding: "4px 12px", borderRadius: 20,
    background: ok ? "#d4edda" : "#f8d7da", color: ok ? "#155724" : "#721c24",
    fontWeight: 700,
  });

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 860, margin: "0 auto", background: "#f6f7f9", minHeight: "100vh" }}>
      <h1>🔐 Session Cookies → WebView Login (live demo)</h1>
      <p style={{ color: "#555" }}>
        Temporary demo page — read-only. Cookie values kahin render nahi hote.
      </p>

      <section style={card}>
        <h2>1️⃣ Login kaise hota hai</h2>
        <ol>
          <li>Phone ke WebView me tum ek baar contentrewards.com pe login karte ho.</li>
          <li>WebView ke cookies (session + access token) encrypted save ho jaate hain.</li>
          <li>Har request me wahi cookies <code>Cookie</code> header me bheje jaate hain — password/OTP dobara nahi lagta.</li>
          <li>Site <code>/api/auth/authenticate/session</code> pe <b>200</b> de → samjho login ho gaya.</li>
        </ol>
        <p>
          Live check: <span style={badge(loggedIn)}>{loggedIn ? "✅ LOGGED IN" : `❌ NOT LOGGED IN (${authStatus})`}</span>
        </p>
        <ul>
          <li>Saved cookies: <b>{names.length}</b> ({crNames.length} Content Rewards)</li>
          <li>Access token valid until: <b>{tokenExp}</b></li>
          <li>Account: <b>{account || "—"}</b></li>
          <li>Last sync: {String(s.updated_at || "—")}</li>
        </ul>
      </section>

      <section style={card}>
        <h2>2️⃣ Submission list ({subs.length})</h2>
        {drafts > 0 && <p>⚠️ {drafts} draft(s) bhi hain.</p>}
        {subs.length === 0 && <p>Koi submission nahi mili.</p>}
        {subs.map((it, i) => (
          <div key={i} style={{ borderTop: "1px solid #eee", padding: "10px 0" }}>
            <div><b>{String(it["campaign.name"] || it["campaignName"] || it["campaign_name"] || it.campaignId || it.campaign_id || "—")}</b></div>
            <div style={{ color: "#555", fontSize: 14 }}>
              status: {String(it.status || it.state || it.reviewStatus || "—")}
              {" · "}platform: {String(it.platform || "—")}
              {" · "}{String(it.createdAt || it.created_at || "")}
            </div>
            {!!(it.postUrl || it.post_url || it.postURL) && (
              <div style={{ fontSize: 14 }}>
                <a href={String(it.postUrl || it.post_url || it.postURL)} target="_blank" rel="noreferrer">
                  {String(it.postUrl || it.post_url || it.postURL)}
                </a>
              </div>
            )}
          </div>
        ))}
      </section>

      <section style={card}>
        <h2>3️⃣ Submit kaise hota hai</h2>
        <ol>
          <li>Reel Instagram pe post hota hai (phone se, real device).</li>
          <li>Server wahi saved cookies ke saath <code>POST /api/submission/submissions</code> karta hai — body me campaign id + reel URL + platform.</li>
          <li><b>200</b> aaya → submission ban gayi, upar wali list me dikhegi.</li>
          <li><b>401</b> aaya → site ka app khud <code>refreshSession</code> karke naya token leta hai aur retry karta hai.</li>
        </ol>
        <p style={{ color: "#555", fontSize: 14 }}>
          Note: 2026-09-23 21:31 IST ko ek authorized attempt par 401 aaya tha — koi submission nahi bani, koi retry nahi hua.
          Ye page kuch bhi submit nahi karta.
        </p>
      </section>
    </main>
  );
}
