/**
 * lib/fcm.ts — server → phone FCM push via FCM HTTP v1 (WhopClip).
 *
 * Pattern: FIREBASE_SERVICE_ACCOUNT env (poora service-account JSON,
 * Vercel encrypted env — ClipFlow ka Firebase project `clip-flow-685a5`
 * reuse, user order) → RS256 JWT sign (Node built-in `crypto`, koi extra
 * dependency nahi) → OAuth2 access token → POST
 * https://fcm.googleapis.com/v1/projects/{project_id}/messages:send
 *
 * APP-FIRST CONTRACT (FormMitra jaisa): FCM sirf ek "wake" signal hai —
 * naya job enqueue ho ya cron ko phone jagana ho to push bhejo taaki app
 * turant poll kare. KOI BHI FLOW FCM par depend nahi karta: phone ka
 * polling fallback hamesha rehta hai, isliye push fail/skip ho to product
 * nahi rukta.
 *
 * FAIL-SOFT: env missing/invalid → skip + log, kabhi throw nahi.
 * sendPush kabhi throw nahi karta — hamesha { ok, reason? } deta hai taaki
 * request handlers aur enqueue path kabhi crash na ho.
 */

import { createSign } from "crypto";

export const FCM_NOT_CONFIGURED = "fcm_not_configured";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** FCM data payload rule: sirf string values. */
  data?: Record<string, string>;
}

export interface FcmResult {
  ok: boolean;
  /** fcm_not_configured | fcm_error | fcm_invalid_token */
  reason?: string;
  messageId?: string;
}

/** Env se service account nikalo — missing/invalid → null. */
function getServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (sa.project_id && sa.client_email && sa.private_key) {
      return {
        project_id: String(sa.project_id),
        client_email: String(sa.client_email),
        private_key: String(sa.private_key),
      };
    }
    console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT JSON adhura hai.");
    return null;
  } catch {
    console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT parse nahi hua.");
    return null;
  }
}

/** Key set hai ya nahi — push bhejne se pehle ka cheap check. */
export function fcmConfigured(): boolean {
  return getServiceAccount() !== null;
}

// Access-token cache (serverless instance ke andar; ~50 min).
let cachedToken: { token: string; exp: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Service account se OAuth2 access token (firebase.messaging scope). */
async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = b64url(signer.sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OAuth token HTTP ${res.status}: ${t.slice(0, 120)}`);
  }
  const j = (await res.json()) as { access_token?: string };
  const token = j?.access_token;
  if (!token) throw new Error("OAuth access_token nahi mila.");
  cachedToken = { token, exp: Date.now() + 50 * 60_000 };
  return token;
}

/**
 * Ek device ko FCM push bhejo. Kabhi throw nahi karta:
 * env missing → { ok:false, reason:"fcm_not_configured" };
 * send fail → { ok:false, reason:"fcm_error"|"fcm_invalid_token" }.
 */
export async function sendPush(
  deviceToken: string,
  payload: PushPayload
): Promise<FcmResult> {
  const sa = getServiceAccount();
  if (!sa) {
    console.log(
      `[fcm] skip — FIREBASE_SERVICE_ACCOUNT set nahi hai (title="${payload.title}"). ` +
        `Polling fallback automatic — phone apne schedule pe poll karega.`
    );
    return { ok: false, reason: FCM_NOT_CONFIGURED };
  }
  if (!deviceToken) {
    return { ok: false, reason: "fcm_invalid_token" };
  }
  try {
    const accessToken = await getAccessToken(sa);
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload.data ?? {})) {
      data[k] = String(v);
    }
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          // Bearer token kabhi log mat karo.
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: payload.title, body: payload.body },
            data,
            android: { priority: "high" },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    let j: Record<string, unknown> = {};
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const errMsg = JSON.stringify(j).slice(0, 200);
      console.warn(`[fcm] send fail HTTP ${res.status}: ${errMsg}`);
      const invalid =
        res.status === 404 || /NOT_FOUND|INVALID_ARGUMENT/.test(errMsg);
      return { ok: false, reason: invalid ? "fcm_invalid_token" : "fcm_error" };
    }
    return { ok: true, messageId: j?.name as string | undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[fcm] send exception: ${msg}`);
    return { ok: false, reason: "fcm_error" };
  }
}
