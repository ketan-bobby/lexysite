/**
 * requireSameOriginPost.ts — Origin / Referer allowlist for cookie-authed
 * state-changing requests.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The interview-session cookie is already well-protected:
 *   - HttpOnly + Secure (prod) + SameSite=Lax
 *   - Path-scoped to /api/interviews/<sessionId>
 *   - Bound to a UA / Sec-CH-UA fingerprint (mismatch forces email OTP)
 *   - CORS credentials restricted to CORS_ORIGIN whitelist in prod
 *
 * SameSite=Lax already blocks cross-site form-POST CSRF in modern browsers.
 * This middleware adds a belt-and-braces server-side check: every state-
 * changing cookie request must declare an Origin (or Referer fallback) that
 * matches our allowlist. That catches:
 *   - Misbehaving browsers / extensions that bypass SameSite
 *   - Same-site attackers (e.g. a vulnerable sibling subdomain that could
 *     otherwise ride the cookie)
 *   - Defensive depth if SameSite is ever loosened by mistake
 *
 * ─── Behaviour ───────────────────────────────────────────────────────────────
 * - Skipped for safe methods (GET, HEAD, OPTIONS) — cookies are read-only there.
 * - When neither Origin nor Referer is set, we REJECT. Modern browsers always
 *   send at least one for fetch()/XHR initiated by user code.
 * - Wildcards like "*" in the allowlist are rejected at config parse — using
 *   "*" with credentialled cookies is a critical misconfiguration.
 * - Allowlist tokens must be a valid URL with scheme + host (no path / query /
 *   fragment). Garbage tokens are dropped at parse with an error log, NOT
 *   silently treated as matching everything.
 * - In production (NODE_ENV === "production"), an EMPTY allowlist throws at
 *   module load. This is intentional — running a SaaS in prod with no
 *   declared frontend origin means we've shipped a misconfiguration; we
 *   prefer a loud crash to a silent "only same-origin works, and the user
 *   wonders why login doesn't function from app.l3xy.com".
 * - In dev / test, an empty allowlist warns but lets the server boot;
 *   the request's own host is always accepted as same-origin so `curl` and
 *   local dev fetches work.
 */
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

/** Validate a single allowlist token is a clean origin: scheme + host (+port).
 *  Returns the canonical form, or null if the token is unusable. Rejects path,
 *  query, fragment, and credentials — those almost always indicate someone
 *  pasted a full URL into the env var by accident. */
function normaliseOriginToken(token: string): string | null {
  try {
    const u = new URL(token);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (u.pathname !== "/" && u.pathname !== "") return null;
    if (u.search || u.hash) return null;
    /* `URL` always includes a trailing slash on pathname for origin-only URLs;
     * return scheme://host[:port] with no slash so it matches `req.headers.origin`. */
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/* Parse the same allowlist the CORS layer uses. Comma-separated env var
 * CORS_ORIGIN. Each token must be a clean origin (scheme + host [+ port]). */
function parseAllowedOrigins(): Set<string> {
  const raw = process.env.CORS_ORIGIN ?? "";
  const out = new Set<string>();
  for (const token of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (token === "*") {
      logger.error(
        "[requireSameOriginPost] CORS_ORIGIN contains '*' — refusing to add to allowlist. " +
          "Wildcard origins are incompatible with credentialled cookies.",
      );
      continue;
    }
    const norm = normaliseOriginToken(token);
    if (!norm) {
      logger.error(
        { token },
        "[requireSameOriginPost] dropped malformed CORS_ORIGIN entry — must be scheme://host[:port] with no path/query/fragment/credentials",
      );
      continue;
    }
    out.add(norm);
  }
  return out;
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

if (ALLOWED_ORIGINS.size === 0) {
  if (process.env.NODE_ENV === "production") {
    /* Fail loudly. Silent same-origin-only mode in prod is a security/UX bug:
     * cross-origin frontends (e.g. app.l3xy.com → api.l3xy.com) will return
     * 403 with no explanation, and the operator may never trace it back here. */
    throw new Error(
      "[requireSameOriginPost] CORS_ORIGIN is empty in production. Set it to a comma-separated list of allowed frontend origins (e.g. https://app.l3xy.com,https://l3xy.com).",
    );
  }
  logger.warn(
    "[requireSameOriginPost] CORS_ORIGIN is empty (dev). Same-origin requests will still pass; cross-origin will be rejected.",
  );
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Extract scheme+host+port from a full URL string. Returns null on parse error. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Core Origin/Referer allowlist check, shared by the strict per-route
 *  middleware (requireSameOriginPost) and the conditional global guard
 *  (csrfOriginGuard). Sends the 403 itself and returns false on rejection;
 *  returns true when the caller may proceed. */
function passesOriginCheck(req: Request, res: Response, tag: string): boolean {
  const origin = (req.headers.origin as string | undefined) ?? null;
  const referer = req.headers.referer as string | undefined;
  const candidate = origin ?? originOf(referer);

  if (!candidate) {
    /* No Origin AND no Referer. Reject — modern browsers always send at least
     * one for state-changing cross-origin fetches. The most likely cause is a
     * scripted attack or a stripping proxy; either way, fail closed. */
    logger.warn(
      { path: req.path, method: req.method, ua: req.headers["user-agent"] },
      `[${tag}] missing Origin and Referer on state-changing request`,
    );
    res.status(403).json({ error: "Missing Origin/Referer header" });
    return false;
  }

  /* Build the effective allowlist. Always include same-origin (the request's
   * own host) as a permitted source so direct API calls from the API host
   * itself work. */
  const sameOrigin = `${req.protocol}://${req.get("host") ?? ""}`;
  if (candidate === sameOrigin) return true;
  if (ALLOWED_ORIGINS.has(candidate)) return true;

  logger.warn(
    { path: req.path, method: req.method, origin: candidate, allowed: [...ALLOWED_ORIGINS] },
    `[${tag}] rejected — origin not in allowlist`,
  );
  res.status(403).json({ error: "Origin not allowed" });
  return false;
}

export function requireSameOriginPost(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!passesOriginCheck(req, res, "requireSameOriginPost")) return;
  next();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * csrfOriginGuard — conditional, API-wide CSRF guard (Phase 3a-1)
 *
 * Registered ONCE on the /api mount (see app.ts), ahead of every route.
 * Unlike requireSameOriginPost above (strict, unconditional, applied
 * per-route to the interview cookie-flow endpoints), this guard enforces
 * the Origin/Referer allowlist ONLY when the request is actually
 * cookie-authenticated:
 *
 *   1. Safe method (GET/HEAD/OPTIONS)          → pass (cookies are read-only)
 *   2. `Authorization` header present           → pass. Bearer requests are
 *      CSRF-immune: an attacker's page cannot attach that header cross-site.
 *      This keeps curl, scripted tests, and any future mobile client working.
 *   3. No `session_token` cookie                → pass. Nothing to forge; the
 *      route's own auth 401s anonymous callers (or the route is public).
 *   4. Path in CSRF_EXEMPT (list below)         → pass. Machine callers and
 *      email-link flows that must work without a browser Origin header.
 *   5. Otherwise (cookie-only state change)     → Origin/Referer must match
 *      the allowlist, or 403.
 *
 * Transition property: while the web frontend still sends Bearer headers
 * (Phase 3b pending), rule 2 skips it. As each frontend call site drops its
 * header, that request becomes cookie-only and the check activates
 * automatically — no second rollout needed.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The session cookie name, duplicated from lib/auth-token.ts deliberately —
 *  importing it would create a middlewares→lib cycle risk and this name is
 *  frozen by the migration. Keep in sync (guard test asserts equality). */
export const CSRF_SESSION_COOKIE = "session_token";

/**
 * CSRF exemption list — the ONLY paths where a cookie-carrying, header-less
 * state-changing request may skip the Origin check. Every entry must say why.
 * Paths are as seen by the /api-mounted middleware (no /api prefix).
 * Matching: exact match, or prefix match for entries ending in "/".
 */
export const CSRF_EXEMPT: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "/webhooks/",       reason: "SES + inbound-email machine callers; requireInboundSecret-guarded; never send browser Origin" },
  { path: "/billing/webhook", reason: "Stripe webhook; signature-verified raw body; machine caller" },
  { path: "/candidates/import", reason: "service-to-service bulk import; X-API-Key (requireImportKey) guarded" },
  { path: "/public/",         reason: "public unauthenticated surface (careers apply, signup forms, hm-share token decisions, reset-password) — token/no-session flows opened from email links" },
  { path: "/newsletter/",     reason: "public subscribe form; no session to forge" },
  { path: "/plans/start-trial", reason: "public magic-link trial signup; no session to forge" },
  { path: "/plans/demo",      reason: "legacy alias of /plans/start-trial" },
  { path: "/outreach/reply/", reason: "candidate email-link reply (token in URL); email clients may strip Referer" },
  { path: "/outreach/reply-msg/", reason: "candidate email-link message-thread reply (token in URL); same as above" },
];

function isCsrfExempt(reqPath: string): boolean {
  for (const e of CSRF_EXEMPT) {
    if (e.path.endsWith("/")) {
      if (reqPath.startsWith(e.path)) return true;
    } else if (reqPath === e.path) {
      return true;
    }
  }
  return false;
}

export function csrfOriginGuard(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (SAFE_METHODS.has(req.method)) return next();

  /* Bearer-authenticated requests are CSRF-immune — skip. */
  const h = req.headers.authorization;
  const auth = Array.isArray(h) ? h[0] : h;
  if (auth && auth.trim()) return next();

  /* No session cookie → nothing an attacker could ride — skip. */
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[CSRF_SESSION_COOKIE];
  if (!cookie || !cookie.trim()) return next();

  if (isCsrfExempt(req.path)) return next();

  if (!passesOriginCheck(req, res, "csrfOriginGuard")) return;
  next();
}
