/**
 * rate-limit-store.ts — Pluggable backend for the rate-limit middleware.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The api-server's rate limiter (middlewares/rateLimit.ts) needs to count
 * requests per (key, route) window. On a single replica an in-process Map is
 * fine. The moment we scale to N replicas each replica has its own Map, so
 * the effective rate ceiling becomes N× the configured ceiling — auth
 * brute-force protection halves with 2 replicas, quarters with 4, etc.
 *
 * This module abstracts the count-store so the same middleware works against
 * either an in-process Map (single replica, dev) or Redis (multi-replica,
 * prod). Selection is automatic based on the REDIS_URL env var.
 *
 * ─── Window modes ───────────────────────────────────────────────────────────
 *   "fixed"   — Fixed window keyed off (key). On the first hit of a fresh
 *               window the TTL is armed; subsequent hits are pure increments.
 *               Cheap (1 INCR + 1 PEXPIRE-NX). Allows up to 2× burst at
 *               window boundaries — acceptable for general API rate limits.
 *
 *   "sliding" — True rolling window. Tracks individual hit timestamps so
 *               "5 hits in the last hour" is enforced precisely, with no
 *               boundary burst. Slightly more expensive (sorted-set ops in
 *               Redis, array-filter in Memory). Use for anti-abuse limits
 *               where boundary bursting would meaningfully weaken the guard
 *               (e.g. demo signup honeypot).
 *
 * ─── Failure mode ────────────────────────────────────────────────────────────
 * Rate limits are an availability shield, not auth. If Redis is unreachable
 * we FAIL OPEN (allow the request) rather than fail closed (lock everyone
 * out). Every failure is captured to system_errors so platform-admins see it
 * on the errors dashboard, but throttled to once-per-minute so a flapping
 * connection doesn't drown the log. Critically, the fail-open decision is
 * made PER REQUEST — there is no sticky "degraded" latch that would keep
 * the limiter disabled after Redis recovers.
 */
import Redis from "ioredis";
import crypto from "node:crypto";
import { logger } from "./logger.js";
import { captureError } from "./error-tracking.js";

export type WindowMode = "fixed" | "sliding";

export interface HitResult {
  /** Count for this key in the current window, after this hit. */
  count: number;
  /** Milliseconds until the current window resets / the oldest hit ages out. */
  ttlMs: number;
}

export interface RateLimitStore {
  /** Register an attempt against `key`, returning the post-attempt count
   *  and the time until the limit "frees up" again.
   *
   *  - mode="fixed":   ALWAYS increments. count = N after this attempt.
   *  - mode="sliding": CHECK-THEN-ADD — if the bucket is already at/over
   *    `limit`, the new attempt is NOT persisted (so a bot retrying after
   *    a 429 doesn't keep extending its own lockout — matches the prior
   *    isDemoRateLimited semantics). The returned count is the "would-be"
   *    count (prior + 1), so the middleware's `count > max` check still
   *    correctly blocks. */
  hit(key: string, windowMs: number, mode: WindowMode, limit: number): Promise<HitResult>;
  /** Backend name for /healthz and startup logging. */
  readonly backend: "memory" | "redis";
}

/* ── MemoryStore ──────────────────────────────────────────────────────────── */
interface FixedEntry { kind: "fixed"; count: number; resetAt: number; }
interface SlidingEntry { kind: "sliding"; hits: number[]; }
type MemEntry = FixedEntry | SlidingEntry;

export class MemoryStore implements RateLimitStore {
  readonly backend = "memory" as const;
  private buckets = new Map<string, MemEntry>();

  constructor() {
    /* Periodically prune expired buckets so the map can't grow without bound. */
    const PRUNE_INTERVAL_MS = 5 * 60_000;
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.buckets) {
        if (v.kind === "fixed" && v.resetAt <= now) this.buckets.delete(k);
        else if (v.kind === "sliding" && v.hits.length === 0) this.buckets.delete(k);
      }
    }, PRUNE_INTERVAL_MS).unref();
  }

  async hit(key: string, windowMs: number, mode: WindowMode, limit: number): Promise<HitResult> {
    const now = Date.now();
    if (mode === "fixed") {
      const entry = this.buckets.get(key);
      if (!entry || entry.kind !== "fixed" || entry.resetAt <= now) {
        const fresh: FixedEntry = { kind: "fixed", count: 1, resetAt: now + windowMs };
        this.buckets.set(key, fresh);
        return { count: 1, ttlMs: windowMs };
      }
      entry.count += 1;
      return { count: entry.count, ttlMs: entry.resetAt - now };
    }
    // sliding — check-then-add: only persist this hit if we're still under
    // the limit. Returns prior+1 either way so the middleware's >max check
    // still blocks when at capacity. Matches the old isDemoRateLimited.
    const cutoff = now - windowMs;
    let entry = this.buckets.get(key);
    if (!entry || entry.kind !== "sliding") {
      entry = { kind: "sliding", hits: [] };
      this.buckets.set(key, entry);
    }
    entry.hits = entry.hits.filter((t) => t > cutoff);
    const prior = entry.hits.length;
    if (prior < limit) entry.hits.push(now);
    const oldest = entry.hits[0] ?? now;
    const ttlMs = Math.max(1, oldest + windowMs - now);
    return { count: prior + 1, ttlMs };
  }
}

/* ── RedisStore ──────────────────────────────────────────────────────────── */
const REDIS_KEY_PREFIX = "rl:";

export class RedisStore implements RateLimitStore {
  readonly backend = "redis" as const;
  private client: Redis;
  /** Last connection lifecycle state from ioredis. Updated by event handlers
   *  only — this is NOT a sticky fail-open latch. Each hit() makes its own
   *  attempt; transient command failures don't disable future calls. */
  private connected = false;
  /** Per-minute throttle on capturing Redis failures so a flapping
   *  connection doesn't drown the error tracker. */
  private lastFailureLogAt = 0;

  constructor(url: string) {
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    // Atomic sliding-window check-then-add. Doing this as a Lua script keeps
    // the prune→count→maybe-add sequence atomic across replicas — without
    // it, two replicas could both see "count < limit" and both add, briefly
    // exceeding the cap by N-1.
    this.client.defineCommand("rlSlidingHit", {
      numberOfKeys: 1,
      lua: `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local windowMs = tonumber(ARGV[2])
        local cutoff = tonumber(ARGV[3])
        local limit = tonumber(ARGV[4])
        local member = ARGV[5]
        redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
        local count = redis.call('ZCARD', key)
        if count < limit then
          redis.call('ZADD', key, now, member)
          redis.call('PEXPIRE', key, windowMs)
        end
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local oldestScore = oldest[2]
        if not oldestScore then oldestScore = tostring(now) end
        return { count + 1, oldestScore }
      `,
    });
    this.client.on("ready", () => { this.connected = true;  logger.info("[rate-limit] redis connected"); });
    this.client.on("end",   () => { this.connected = false; logger.warn("[rate-limit] redis connection closed"); });
    this.client.on("error", (err) => this.recordFailure(err));
    this.client.connect().catch((err) => this.recordFailure(err));
  }

  private recordFailure(err: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < 60_000) return;
    this.lastFailureLogAt = now;
    logger.error({ err }, "[rate-limit] redis error — this request fails OPEN; retrying on next");
    captureError(err, { source: "rate-limit-redis", extra: { reason: "redis_unavailable" } });
  }

  async hit(key: string, windowMs: number, mode: WindowMode, limit: number): Promise<HitResult> {
    // Don't even attempt if ioredis reports the connection is down — the
    // command would just time out anyway. We'll retry on the very next call,
    // which is the right behaviour once the client reconnects.
    if (!this.connected) {
      return { count: 1, ttlMs: windowMs };
    }
    const redisKey = REDIS_KEY_PREFIX + key;
    try {
      if (mode === "fixed") {
        const pipeline = this.client.multi();
        pipeline.incr(redisKey);
        // NX = only set TTL if no TTL exists yet (i.e. on the first hit of
        // a fresh window). Without NX we'd reset the window on every hit and
        // limits would never expire under sustained load.
        pipeline.pexpire(redisKey, windowMs, "NX");
        pipeline.pttl(redisKey);
        const replies = await pipeline.exec();
        if (!replies) throw new Error("redis pipeline returned null");
        const [incrReply, , pttlReply] = replies;
        if (incrReply?.[0]) throw incrReply[0];
        if (pttlReply?.[0]) throw pttlReply[0];
        const count = Number(incrReply?.[1] ?? 0);
        let ttlMs = Number(pttlReply?.[1] ?? -1);
        if (ttlMs < 0) ttlMs = windowMs;
        return { count, ttlMs };
      }
      // sliding: atomic check-then-add via Lua. Random member suffix so two
      // hits in the same millisecond don't collide on ZSET unique-member.
      const now = Date.now();
      const cutoff = now - windowMs;
      const member = `${now}-${crypto.randomBytes(4).toString("hex")}`;
      // ioredis types defineCommand'd calls as `any` — cast for clarity.
      const reply = (await (this.client as unknown as {
        rlSlidingHit: (k: string, now: string, win: string, cut: string, lim: string, m: string) => Promise<[number, string]>;
      }).rlSlidingHit(redisKey, String(now), String(windowMs), String(cutoff), String(limit), member));
      const count = Number(reply[0]);
      const oldestScore = Number(reply[1]);
      const ttlMs = Math.max(1, oldestScore + windowMs - now);
      return { count, ttlMs };
    } catch (err) {
      this.recordFailure(err);
      return { count: 1, ttlMs: windowMs };
    }
  }

  async disconnect(): Promise<void> {
    try { await this.client.quit(); } catch { /* ignore */ }
  }
}

/* ── Default store (singleton, auto-selected on REDIS_URL) ────────────────── */
let _store: RateLimitStore | null = null;
export function getDefaultStore(): RateLimitStore {
  if (_store) return _store;
  const url = process.env.REDIS_URL?.trim();
  if (url) {
    logger.info("[rate-limit] using RedisStore — multi-replica safe");
    _store = new RedisStore(url);
  } else {
    logger.info("[rate-limit] using MemoryStore — single-replica only. Set REDIS_URL to scale horizontally.");
    _store = new MemoryStore();
  }
  return _store;
}

/** Test seam — let tests inject a custom store. */
export function _setStoreForTesting(store: RateLimitStore | null): void {
  _store = store;
}
