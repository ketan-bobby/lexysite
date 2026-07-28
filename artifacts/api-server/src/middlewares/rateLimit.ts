/**
 * rateLimit.ts — Pluggable rate-limit middleware
 *
 * Per-(key, route) limiter. Default key is the resolved user id; falls back
 * to req.ip for unauthenticated routes. Backed by lib/rate-limit-store.ts —
 * defaults to an in-process Map for single-replica deployments, automatically
 * switches to Redis when REDIS_URL is set.
 *
 * Usage:
 *   router.post("/converse",
 *     rateLimit({ windowMs: 60_000, max: 60 }),  // 60 / minute / user
 *     handler);
 *
 * On limit, responds 429 with { error, retryAfterMs } and sets Retry-After.
 *
 * Behaviour notes:
 *   - Limiter calls are async (Redis round-trip); the middleware awaits
 *     before next(). Median latency on a healthy Redis is sub-millisecond.
 *   - If the store fails (Redis unreachable), it fails OPEN (allows the
 *     request) and the failure is captured via lib/error-tracking. Rate
 *     limits protect availability, they aren't auth.
 */
import type { Request, Response, NextFunction } from "express";
import { getDefaultStore, type RateLimitStore, type WindowMode } from "../lib/rate-limit-store.js";

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per key per window. */
  max: number;
  /** Optional override for the bucket key. Defaults to userId || req.ip. */
  keyFn?: (req: Request) => string;
  /** Optional shared bucket name. When set, the per-route suffix is replaced
   *  with this constant so multiple routes can share a single budget
   *  (e.g. /auth/login + /auth/candidate-login share `auth-login`). When
   *  omitted, behaviour is unchanged: each route gets its own bucket. */
  scope?: string;
  /** Window enforcement mode.
   *  - "fixed"   (default): fixed window; allows up to 2× burst at the
   *    boundary; one INCR per hit. Fine for ordinary API rate limits.
   *  - "sliding": true rolling window; no boundary burst; slightly more
   *    expensive per hit. Use for anti-abuse guards. */
  mode?: WindowMode;
  /** Test seam — inject a custom store. Defaults to the auto-selected
   *  singleton from rate-limit-store.ts (Memory in dev, Redis in prod). */
  store?: RateLimitStore;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, keyFn, scope, mode = "fixed" } = opts;
  return async (req: Request, res: Response, next: NextFunction) => {
    const store = opts.store ?? getDefaultStore();
    const userKey = keyFn
      ? keyFn(req)
      : (req.resolvedUser?.id || req.ip || "anon");
    /* If `scope` is set, all routes that pass the same scope share a bucket.
       Otherwise distinguish per route so /converse and /mocks/complete have
       independent budgets even for the same caller. req.route?.path is set
       after match. */
    const routeKey = scope ?? (req.baseUrl + (req.route?.path ?? req.path));
    const key = `${userKey}::${routeKey}`;

    const { count, ttlMs } = await store.hit(key, windowMs, mode, max);

    if (count > max) {
      res.setHeader("Retry-After", Math.ceil(ttlMs / 1000).toString());
      res.status(429).json({
        error: "Too many requests",
        retryAfterMs: ttlMs,
      });
      return;
    }
    next();
  };
}
