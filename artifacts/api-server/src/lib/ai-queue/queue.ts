/**
 * lib/ai-queue/queue.ts — AI job queue primitives
 *
 * Thin data-access layer over the `ai_jobs` table. The HTTP layer calls
 * `enqueueAiJob`; the worker (lib/ai-queue/worker.ts) calls `claimNextJob`,
 * `completeJob`, `failJob` and `reclaimStuckJobs`.
 *
 * All queries run on `dbAdmin` (BYPASSRLS). The queue is cross-tenant by design
 * — a single worker pool drains jobs for every tenant — and runs outside any
 * HTTP request context, so the RLS-aware `db` proxy would just fall through to
 * dbAdmin anyway. We import dbAdmin explicitly to make that intent obvious.
 */
import { dbAdmin, aiJobsTable, type AiJob, type AiJobType } from "@workspace/db";
import { sql, and, eq, lt, inArray } from "drizzle-orm";
import { logger } from "../logger";

/* Exponential backoff (ms) applied to runAt after a failed attempt, indexed by
 * retryCount. Capped at the last entry for any further retries. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000];

export interface EnqueueArgs {
  type: AiJobType;
  payload: Record<string, unknown>;
  tenantId?: string | null;
  interviewSessionId?: string | null;
  /** Idempotency key. If a non-failed job already exists with this key, the
   *  enqueue is skipped and the existing job is returned. */
  dedupeKey?: string | null;
  priority?: number;
  maxAttempts?: number;
}

/**
 * Insert a job (or return the existing one when `dedupeKey` collides with a
 * pending/processing/completed job). Best-effort: never throws into the caller's
 * request path — a failed enqueue is logged and returns null so the live
 * interview flow is never broken by queue problems.
 */
export async function enqueueAiJob(args: EnqueueArgs): Promise<AiJob | null> {
  /** Resolve the existing LIVE (non-failed) job for a dedupeKey, if any. */
  const findLive = async (key: string): Promise<AiJob | null> => {
    const [existing] = await dbAdmin
      .select()
      .from(aiJobsTable)
      .where(
        and(
          eq(aiJobsTable.dedupeKey, key),
          /* Only a `failed` job should be re-enqueueable under the same key. */
          inArray(aiJobsTable.status, ["pending", "processing", "completed"]),
        ),
      )
      .limit(1);
    return existing ?? null;
  };

  try {
    /* Fast path: skip the insert if a live job already exists. */
    if (args.dedupeKey) {
      const existing = await findLive(args.dedupeKey);
      if (existing) return existing;
    }
    const [job] = await dbAdmin
      .insert(aiJobsTable)
      .values({
        type: args.type,
        payload: args.payload as any,
        tenantId: args.tenantId ?? null,
        interviewSessionId: args.interviewSessionId ?? null,
        dedupeKey: args.dedupeKey ?? null,
        priority: args.priority ?? 0,
        maxAttempts: args.maxAttempts ?? 5,
      })
      .returning();
    return job ?? null;
  } catch (err: any) {
    /* Race backstop: a concurrent enqueue won the partial unique index
       (ai_jobs_dedupe_live_uq). 23505 = unique_violation — resolve to the
       winner's row rather than reporting a spurious enqueue failure. */
    if (args.dedupeKey && err?.code === "23505") {
      try {
        const existing = await findLive(args.dedupeKey);
        if (existing) return existing;
      } catch (reErr: any) {
        logger.error(
          { err: reErr?.message, type: args.type },
          "[ai-queue] enqueue dedupe re-select failed",
        );
      }
    }
    logger.error({ err: err?.message, type: args.type }, "[ai-queue] enqueue failed");
    return null;
  }
}

/**
 * Atomically claim the next runnable job for this worker.
 *
 * The UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) pattern lets
 * many workers poll concurrently: each grabs a distinct row and any row already
 * locked by another worker's transaction is skipped instead of blocking.
 * Returns null when there is nothing to do.
 */
export async function claimNextJob(workerId: string): Promise<AiJob | null> {
  const result = await dbAdmin.execute(sql`
    UPDATE ${aiJobsTable}
       SET status = 'processing',
           locked_at = now(),
           locked_by = ${workerId},
           started_at = COALESCE(started_at, now()),
           retry_count = retry_count + 1,
           updated_at = now()
     WHERE id = (
       SELECT id FROM ${aiJobsTable}
        WHERE status = 'pending'
          AND run_at <= now()
        ORDER BY priority DESC, run_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  const row = (result as any).rows?.[0];
  return (row as AiJob) ?? null;
}

/** Mark a claimed job completed and store its result. */
export async function completeJob(jobId: string, result: unknown): Promise<void> {
  await dbAdmin
    .update(aiJobsTable)
    .set({
      status: "completed",
      result: (result ?? null) as any,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(aiJobsTable.id, jobId));
}

/**
 * Record a failed attempt. Re-queues with exponential backoff while attempts
 * remain; otherwise marks the job terminally `failed`.
 */
export async function failJob(job: AiJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const attemptsUsed = job.retryCount; // already incremented by claimNextJob
  const exhausted = attemptsUsed >= job.maxAttempts;
  if (exhausted) {
    await dbAdmin
      .update(aiJobsTable)
      .set({
        status: "failed",
        lastError: message.slice(0, 2000),
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(aiJobsTable.id, job.id));
    logger.error({ jobId: job.id, type: job.type, attemptsUsed }, "[ai-queue] job permanently failed");
    return;
  }
  const backoff = BACKOFF_MS[Math.min(attemptsUsed - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
  await dbAdmin
    .update(aiJobsTable)
    .set({
      status: "pending",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      runAt: new Date(Date.now() + backoff),
      updatedAt: new Date(),
    })
    .where(eq(aiJobsTable.id, job.id));
  logger.warn(
    { jobId: job.id, type: job.type, attemptsUsed, backoffMs: backoff },
    "[ai-queue] job failed — will retry",
  );
}

/**
 * Reclaim jobs stuck in `processing` (worker crashed mid-job) by flipping them
 * back to `pending` so another worker can pick them up. Returns the count
 * reclaimed. A job that has already exhausted its attempts is marked failed.
 */
export async function reclaimStuckJobs(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const stuck = await dbAdmin
    .select()
    .from(aiJobsTable)
    .where(and(eq(aiJobsTable.status, "processing"), lt(aiJobsTable.lockedAt, cutoff)));
  for (const job of stuck) {
    if (job.retryCount >= job.maxAttempts) {
      await dbAdmin
        .update(aiJobsTable)
        .set({
          status: "failed",
          lastError: "Worker timed out / crashed before completion",
          lockedAt: null,
          lockedBy: null,
          updatedAt: new Date(),
        })
        .where(eq(aiJobsTable.id, job.id));
    } else {
      await dbAdmin
        .update(aiJobsTable)
        .set({
          status: "pending",
          lastError: "Reclaimed after worker timeout",
          lockedAt: null,
          lockedBy: null,
          runAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(aiJobsTable.id, job.id));
    }
  }
  if (stuck.length) logger.warn({ count: stuck.length }, "[ai-queue] reclaimed stuck jobs");
  return stuck.length;
}

/** Re-queue a terminally-failed (or any) job from the admin dashboard. */
export async function retryJob(jobId: string): Promise<AiJob | null> {
  const [job] = await dbAdmin
    .update(aiJobsTable)
    .set({
      status: "pending",
      retryCount: 0,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      runAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(aiJobsTable.id, jobId))
    .returning();
  return job ?? null;
}
