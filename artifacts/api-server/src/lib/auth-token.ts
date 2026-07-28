/**
 * auth-token.ts — HMAC-signed bearer tokens
 *
 * Compact, stateless session tokens used by every protected route. Replaces
 * the previous "demo_token_<userId>" scheme which was trivially forgeable.
 *
 * Format:  v2.<base64url(payload)>.<base64url(hmac)>
 *   payload = { sub, role, tenantId, iat, exp }
 *   hmac    = HMAC-SHA256(secret, "v2." + base64url(payload))
 *
 * Secret:
 *   SESSION_SECRET env var. In production it is REQUIRED — the module throws
 *   on first use if missing. In development we generate a process-lifetime
 *   random secret and log a warning; this means dev tokens invalidate on
 *   every server restart, which is the correct behaviour for a dev secret.
 *
 * Backward compatibility:
 *   When NODE_ENV !== "production" AND DEV_AUTH_FALLBACK=true, verifyToken()
 *   also accepts the legacy "demo_token_<userId>" format so existing local
 *   bookmarks / scripts keep working during the rollout. The fallback is
 *   off by default and unconditionally rejected in production.
 */
import crypto from "crypto";
import { logger } from "./logger";

export const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let _secret: string | null = null;
function getSecret(): string {
  if (_secret) return _secret;
  const env = process.env.SESSION_SECRET;
  if (env && env.length >= 32) {
    _secret = env;
    return _secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET environment variable is required in production " +
        "(min 32 chars). Refusing to issue or verify tokens with an " +
        "ephemeral secret.",
    );
  }
  _secret = crypto.randomBytes(32).toString("hex");
  logger.warn(
    "[auth-token] SESSION_SECRET not set — using ephemeral dev secret. " +
      "All sessions will invalidate on restart. Set SESSION_SECRET (>=32 chars) for stability.",
  );
  return _secret;
}

function b64urlEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64: string): string {
  const mac = crypto.createHmac("sha256", getSecret())
    .update("v2." + payloadB64)
    .digest();
  return b64urlEncode(mac);
}

function timingSafeStrEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface TokenPayload {
  sub: string;        // userId
  role: string;
  tenantId: string | null;
  /** Multi-region Phase 0: data-residency cell the user's tenant lives in.
   *  Optional on the type so we can still verify pre-existing tokens issued
   *  before the claim existed — resolveUser falls back to a tenant lookup
   *  in that case. All new tokens carry it. */
  region?: string;
  iat: number;        // issued-at, seconds
  exp: number;        // expires-at, seconds
}

export function issueToken(p: { userId: string; role: string; tenantId: string | null; region?: string | null }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    sub: p.userId,
    role: p.role,
    tenantId: p.tenantId,
    ...(p.region ? { region: p.region } : {}),
    iat: now,
    exp: now + TTL_SECONDS,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return `v2.${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload; legacy?: boolean }
  | { ok: false; reason: "missing" | "malformed" | "bad_sig" | "expired" | "legacy_disabled" };

/**
 * Verify a bearer token. Returns the decoded payload or a structured error.
 * Does NOT touch the database — callers still resolve the user row to pick
 * up role/tenant changes that happened after issuance.
 */
export function verifyToken(raw: string | null | undefined): VerifyResult {
  if (!raw) return { ok: false, reason: "missing" };
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, reason: "missing" };

  // Modern v2 token
  if (token.startsWith("v2.")) {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const [, payloadB64, sig] = parts;
    const expected = sign(payloadB64);
    if (!timingSafeStrEq(sig, expected)) return { ok: false, reason: "bad_sig" };
    let payload: TokenPayload;
    try {
      payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (typeof payload?.sub !== "string" || typeof payload?.exp !== "number") {
      return { ok: false, reason: "malformed" };
    }
    if (payload.exp * 1000 < Date.now()) return { ok: false, reason: "expired" };
    return { ok: true, payload };
  }

  // Legacy "demo_token_<userId>" — only honoured in non-prod with explicit opt-in
  if (token.startsWith("demo_token_")) {
    const allowLegacy =
      process.env.NODE_ENV !== "production" &&
      process.env.DEV_AUTH_FALLBACK === "true";
    if (!allowLegacy) return { ok: false, reason: "legacy_disabled" };
    const userId = token.slice("demo_token_".length);
    if (!userId) return { ok: false, reason: "malformed" };
    const now = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      legacy: true,
      payload: { sub: userId, role: "", tenantId: null, iat: now, exp: now + 60 },
    };
  }

  return { ok: false, reason: "malformed" };
}

/**
 * Convenience helper for the dozen route handlers that derive a userId from
 * `req.headers.authorization` themselves (they pre-date resolveUser middleware
 * and run on routes that intentionally don't mount it). Returns the userId on
 * success, null on any failure — callers MUST treat null as 401 and never
 * fall back to a default tenant.
 */
export function getAuthUserId(req: {
  headers: { authorization?: string | string[] };
  cookies?: Record<string, string>;
}): string | null {
  const v = verifyToken(tokenFromRequest(req));
  return v.ok ? v.payload.sub : null;
}

/* ── httpOnly session cookie (Phase 1 of the cookie-auth migration) ─────────
 * The login endpoint sets the SAME v2 token in an httpOnly cookie alongside
 * the existing JSON `{ user, token }` response. Middlewares accept the cookie
 * only when no Authorization header is present — the header path is unchanged
 * and still takes precedence. Direct getAuthUserId() callers remain
 * header-only until a later phase. */
export const SESSION_COOKIE_NAME = "session_token";

/** Extract the raw token string from a request: `Authorization: Bearer …`
 *  header first; if absent, fall back to the httpOnly session cookie.
 *  Returns null when neither is present. */
export function tokenFromRequest(req: {
  headers: { authorization?: string | string[] };
  cookies?: Record<string, string>;
}): string | null {
  const h = req.headers.authorization;
  const auth = Array.isArray(h) ? h[0] : h;
  if (auth && auth.trim()) return auth;
  const cookie = req.cookies?.[SESSION_COOKIE_NAME];
  return cookie && cookie.trim() ? cookie : null;
}

/** Set the httpOnly session cookie on a response. Single source of truth for
 *  the cookie flags — every token-issuing endpoint must use this so the six
 *  issuers can never drift apart. Mirrors the interview-session cookie
 *  pattern (httpOnly, secure in prod, sameSite lax). */
export function setSessionTokenCookie(
  res: { cookie: (name: string, value: string, opts: Record<string, unknown>) => unknown },
  token: string,
): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TTL_SECONDS * 1000, // 30 days — matches the token's own exp
    path: "/api",
  });
}

/** DEV-ONLY token exposure for JSON response bodies. In production the session
 *  rides solely on the httpOnly cookie set by setSessionTokenCookie — the raw
 *  token must never appear in a response body. In non-production the Replit
 *  preview iframe blocks third-party cookies, so the SPA's DEV-only Bearer
 *  fallback (authHeaders() in lexy/src/lib/api.ts) still needs the token.
 *  Spread this into every login-shaped response: `...devOnlyTokenBody(token)`. */
export function devOnlyTokenBody(token: string): { token?: string } {
  return process.env.NODE_ENV === "production" ? {} : { token };
}

/** Clear the httpOnly session cookie (logout). Options must match the ones
 *  used when setting it or the browser won't remove it. */
export function clearSessionTokenCookie(
  res: { clearCookie: (name: string, opts: Record<string, unknown>) => unknown },
): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api",
  });
}
