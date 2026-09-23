import crypto from "crypto";
import { cookies } from "next/headers";

export const AUTH_COOKIE = "whopclip_auth";
const COOKIE_MAX_AGE = 30 * 24 * 3600; // 30 days

/** True when the owner has configured OWNER_PASSWORD on the server. */
export function ownerPasswordSet(): boolean {
  return !!process.env.OWNER_PASSWORD;
}

/**
 * Second owner-level credential (user-set 2026-09-23): the user keeps
 * OWNER_PASSWORD for their own website login; the agent uses AGENT_PASSWORD
 * for automation access. Either password grants full owner access — the two
 * are independent, so the user can rotate theirs without breaking the agent.
 */
export function agentPasswordSet(): boolean {
  return !!process.env.AGENT_PASSWORD;
}

/** True when at least one owner credential is configured. */
export function anyPasswordSet(): boolean {
  return ownerPasswordSet() || agentPasswordSet();
}

function expectedToken(): string {
  const pw = process.env.OWNER_PASSWORD ?? "";
  return crypto.createHmac("sha256", pw).update("whopclip-auth-v1").digest("hex");
}

export function makeAuthCookieValue(): string {
  return expectedToken();
}

export function verifyAuthToken(token: string | undefined | null): boolean {
  if (!token || !ownerPasswordSet()) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Server-component guard: is the current request logged in? */
export function isAuthed(): boolean {
  return verifyAuthToken(cookies().get(AUTH_COOKIE)?.value);
}

export function authCookieHeader(): string {
  return `${AUTH_COOKIE}=${makeAuthCookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}; Secure`;
}

export function clearAuthCookieHeader(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Constant-time password check for the login route. Accepts either the
 *  owner's password or the agent's password (both are owner-level). */
export function checkPassword(candidate: string): boolean {
  return (
    passwordMatches(candidate, process.env.OWNER_PASSWORD ?? "") ||
    passwordMatches(candidate, process.env.AGENT_PASSWORD ?? "")
  );
}

function passwordMatches(candidate: string, pw: string): boolean {
  if (!pw || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(pw);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// env-rotation: force fresh build
