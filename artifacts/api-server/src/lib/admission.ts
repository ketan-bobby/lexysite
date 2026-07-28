/**
 * admission.ts — In-process admission control for expensive AI endpoints
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Bounds how many expensive per-turn AI operations (STT transcribe, LLM
 * converse, TTS) run concurrently in a single api-server process. When a spike
 * pushes in-flight work past the cap, new requests WAIT briefly for a slot and,
 * if none frees up in time, are turned away with 503 + Retry-After instead of
 * piling onto the event loop / upstream providers and dragging everyone down.
 * This converts "everything gets slow / crashes under a spike" into "the system
 * degrades gracefully and tells clients to retry shortly".
 *
 * ─── Backward compatibility (critical) ──────────────────────────────────────
 * The default cap is intentionally generous (AI_MAX_CONCURRENCY, default 200)
 * — far above current real concurrency — so it NEVER triggers at today's load.
 * Under the cap, acquire() resolves immediately and behavior is identical to
 * having no admission control at all.
 *
 * ─── Configuration ──────────────────────────────────────────────────────────
 *   AI_MAX_CONCURRENCY  max concurrent admitted requests (default 200)
 *   AI_ADMIT_WAIT_MS    how long a request waits for a slot before 503 (default 1500)
 */
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";

export interface Semaphore {
  /** Try to take a slot, waiting up to timeoutMs. Resolves true if admitted. */
  acquire(timeoutMs?: number): Promise<boolean>;
  /** Return a previously-acquired slot (and hand it to the next waiter). */
  release(): void;
  /** Current admitted (in-flight) count — for metrics / tests. */
  inFlight(): number;
  /** Number of callers currently waiting for a slot. */
  waiting(): number;
  readonly max: number;
  readonly defaultWaitMs: number;
}

export function createSemaphore(max: number, defaultWaitMs: number): Semaphore {
  let active = 0;
  /* FIFO queue of waiters; each grant() takes the slot for that waiter. */
  const queue: Array<() => void> = [];

  function release(): void {
    const next = queue.shift();
    if (next) {
      /* Hand the slot directly to the next waiter — active stays accounted. */
      next();
    } else {
      active = Math.max(0, active - 1);
    }
  }

  function acquire(timeoutMs: number = defaultWaitMs): Promise<boolean> {
    if (active < max) {
      active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = queue.indexOf(grant);
        if (i >= 0) queue.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      const grant = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        /* Slot was handed over from release() without decrementing active. */
        resolve(true);
      };
      queue.push(grant);
    });
  }

  return {
    acquire,
    release,
    inFlight: () => active,
    waiting: () => queue.length,
    max,
    defaultWaitMs,
  };
}

const MAX = Number(process.env.AI_MAX_CONCURRENCY) || 200;
const WAIT_MS = Number(process.env.AI_ADMIT_WAIT_MS) || 1500;

/* Shared semaphore across the expensive AI endpoints (transcribe / converse /
   tts) so the cap bounds total concurrent AI work per process. */
export const aiSemaphore: Semaphore = createSemaphore(MAX, WAIT_MS);

/**
 * Express middleware that admits a request through the given semaphore (the
 * shared AI semaphore by default), releasing the slot exactly once when the
 * response finishes or the connection closes. On saturation it responds 503
 * with Retry-After so clients back off and retry.
 */
export function admit(sem: Semaphore = aiSemaphore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ok = await sem.acquire();
    if (!ok) {
      logger.warn({ path: req.path, inFlight: sem.inFlight(), waiting: sem.waiting(), max: sem.max }, "[admission] saturated — shedding request with 503");
      res.setHeader("Retry-After", "2");
      res.status(503).json({ error: "server_busy", message: "The interview service is briefly at capacity. Please retry in a moment." });
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      sem.release();
    };
    res.on("finish", releaseOnce);
    res.on("close", releaseOnce);
    next();
  };
}
