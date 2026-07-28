/**
 * lib/ai-queue/worker.ts — AI job queue consumer
 *
 * Polls `ai_jobs`, claims runnable rows (FOR UPDATE SKIP LOCKED via
 * claimNextJob), runs the matching handler with a per-job timeout, and records
 * success/failure. Designed to run in two modes:
 *
 *   • INLINE  — started from the API server process (src/index.ts) so a single
 *               Replit deployment drains its own queue with zero extra config.
 *   • STANDALONE — run as its own process (src/worker.ts) and scaled
 *               horizontally for high throughput. Because claiming uses
 *               SKIP LOCKED, any number of inline + standalone workers can run
 *               at once without ever processing the same job twice.
 *
 * Tunables (env):
 *   AI_WORKER_CONCURRENCY   max jobs processed at once per worker   (default 4)
 *   AI_WORKER_POLL_MS       idle poll interval                      (default 1000)
 *   AI_WORKER_JOB_TIMEOUT_MS per-job hard timeout                   (default 120000)
 *   AI_WORKER_STUCK_MS      reclaim jobs stuck in `processing`      (default 300000)
 */
import { randomUUID } from "crypto";
import os from "os";
import { logger } from "../logger";
import { claimNextJob, completeJob, failJob, reclaimStuckJobs } from "./queue";
import { handlers } from "./handlers";

const CONCURRENCY = Number(process.env.AI_WORKER_CONCURRENCY) || 4;
const POLL_MS = Number(process.env.AI_WORKER_POLL_MS) || 1_000;
const JOB_TIMEOUT_MS = Number(process.env.AI_WORKER_JOB_TIMEOUT_MS) || 120_000;
const STUCK_MS = Number(process.env.AI_WORKER_STUCK_MS) || 300_000;

const WORKER_ID = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

let running = false;
let stopping = false;
let active = 0;
let reclaimTimer: NodeJS.Timeout | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Run a single already-claimed job to completion (handler + record result). */
async function runJob(job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>): Promise<void> {
  const handler = handlers[job.type];
  if (!handler) {
    await failJob(job, new Error(`No handler registered for job type "${job.type}"`));
    return;
  }
  const startedAt = Date.now();
  try {
    const result = await withTimeout(handler(job), JOB_TIMEOUT_MS, `job ${job.id} (${job.type})`);
    await completeJob(job.id, result);
    logger.info(
      { jobId: job.id, type: job.type, ms: Date.now() - startedAt, attempt: job.retryCount },
      "[ai-queue] job completed",
    );
  } catch (err: any) {
    await failJob(job, err);
  }
}

/**
 * The main loop. A single claim happens per iteration so we always know whether
 * there was work:
 *   • at capacity      → short sleep, then re-check (a freed slot is picked up fast)
 *   • claimed a job    → spawn it (non-blocking) and immediately loop to fill more
 *                        slots up to CONCURRENCY
 *   • queue empty      → back off for POLL_MS so we don't hammer the DB
 * The previous version put the idle backoff inside a non-awaited `.then`, so an
 * empty queue spun at ~5ms; this guarantees POLL_MS is actually honored.
 */
async function loop(): Promise<void> {
  while (!stopping) {
    if (active >= CONCURRENCY) {
      await sleep(25);
      continue;
    }
    let job: Awaited<ReturnType<typeof claimNextJob>> = null;
    try {
      job = await claimNextJob(WORKER_ID);
    } catch (err: any) {
      logger.error({ err: err?.message }, "[ai-queue] claim failed");
      await sleep(POLL_MS);
      continue;
    }
    if (!job) {
      await sleep(POLL_MS);
      continue;
    }
    active += 1;
    void runJob(job)
      .catch((err) => logger.error({ err: err?.message, jobId: job?.id }, "[ai-queue] worker job error"))
      .finally(() => { active -= 1; });
    /* Yield briefly, then loop to claim more until we hit CONCURRENCY. */
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Start the worker (idempotent). Safe to call inline from the API process. */
export function startAiWorker(): void {
  if (running) return;
  running = true;
  logger.info(
    { workerId: WORKER_ID, concurrency: CONCURRENCY, pollMs: POLL_MS },
    "[ai-queue] worker started",
  );
  /* Periodically reclaim jobs whose worker died mid-flight. */
  const reclaim = async () => {
    try { await reclaimStuckJobs(STUCK_MS); }
    catch (err: any) { logger.error({ err: err?.message }, "[ai-queue] reclaim failed"); }
  };
  void reclaim();
  reclaimTimer = setInterval(reclaim, Math.max(30_000, STUCK_MS / 2));
  reclaimTimer.unref?.();
  void loop();
}

/** Stop accepting new work and wait for in-flight jobs to drain. */
export async function stopAiWorker(timeoutMs = 25_000): Promise<void> {
  stopping = true;
  if (reclaimTimer) clearInterval(reclaimTimer);
  const deadline = Date.now() + timeoutMs;
  while (active > 0 && Date.now() < deadline) await sleep(100);
  running = false;
  logger.info("[ai-queue] worker stopped");
}
