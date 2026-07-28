/**
 * crypto-secrets.ts — Authenticated symmetric encryption for secrets at rest
 *
 * Used to encrypt OAuth refresh tokens (Microsoft Graph) before they are stored
 * in the database (recruiter_mail_accounts.refresh_token_enc). AES-256-GCM gives
 * us confidentiality + integrity (a tampered ciphertext fails the auth tag).
 *
 * ─── Key management ──────────────────────────────────────────────────────────
 * The 32-byte key is DERIVED from SESSION_SECRET (the same secret that signs
 * bearer tokens) via HKDF-SHA256 with a fixed, versioned info label. This means:
 *   • no new secret to provision/rotate separately, and
 *   • the mail-token key is cryptographically independent of the signing use.
 * In production SESSION_SECRET is required; if it is missing we refuse to derive
 * a key (so we never silently encrypt with a guessable dev key in prod). In dev
 * we fall back to a clearly-insecure constant so local flows work without setup.
 *
 * Ciphertext format (string):  v1:<iv b64>:<tag b64>:<ciphertext b64>
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const INFO = "lexy-graph-token-v1";
const SALT = Buffer.alloc(16, 0); // fixed salt — single-key derivation, not per-record

let _key: Buffer | null = null;
function getKey(): Buffer {
  if (_key) return _key;
  const base = process.env.SESSION_SECRET || process.env.AUTH_SECRET || "";
  if (!base) {
    /* Fail-closed by default: encrypting mail tokens with the hard-coded dev
       key (public in source) must be an explicit local-dev opt-in, not an
       automatic consequence of NODE_ENV being unset/misconfigured. */
    if (process.env.ALLOW_DEV_SECRET_FALLBACK !== "true") {
      throw new Error("SESSION_SECRET (or AUTH_SECRET) is required to encrypt mail tokens at rest — set ALLOW_DEV_SECRET_FALLBACK=true for local dev only");
    }
    _key = Buffer.from(hkdfSync("sha256", Buffer.from("dev-insecure-mail-key"), SALT, INFO, 32));
    return _key;
  }
  _key = Buffer.from(hkdfSync("sha256", Buffer.from(base), SALT, INFO, 32));
  return _key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("unsupported ciphertext format");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
