import crypto from "crypto";

const ALG = "aes-256-gcm";

/** Master key from env (64 hex chars). Never commit a real key. */
function masterKey(): Buffer {
  const hex = process.env.SESSION_MASTER_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("SESSION_MASTER_KEY must be 64 hex chars");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSession(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSession(packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALG, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** Generate a fresh master key (run once, store in Vercel env). */
export function generateMasterKey(): string {
  return crypto.randomBytes(32).toString("hex");
}
