/**
 * lib/pipeline-runs/recorder.ts — Persisted pipeline-run event stream
 *
 * The orchestrator's pipeline runs (pipeline_runs) historically emitted their
 * lifecycle only to an in-memory buffer, which a deploy wipes. This module
 * persists those events to `pipeline_run_events` (migration 0043) so the run
 * audit trail is durable — the pipeline counterpart to lib/agent-runs/recorder.ts.
 *
 * ── Non-blocking by construction ─────────────────────────────────────────────
 * `emitPipelineRunEvent` NEVER throws and NEVER fails or slows a run: it uses the
 * BYPASSRLS admin pool (writes off the request path, always sets tenant_id
 * explicitly), computes `seq` in-statement (so concurrent emits don't collide),
 * and swallows+logs any error. Callers additionally invoke it fire-and-forget
 * (`void emitPipelineRunEvent(...)`), so even the await is off the critical path.
 *
 * ── Retention ────────────────────────────────────────────────────────────────
 * `prunePipelineRunEvents` keeps milestone events forever and deletes only
 * non-milestone rows (e.g. step_started) past the retention window, batched and
 * best-effort. Scheduled by lib/pipeline-run-events-retention-scheduler.ts.
 */
import { dbAdmin, pipelineRunEventsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger";

/** Lifecycle event kinds emitted for a pipeline run. Free-text in the column so
 *  the run_activity_events union view mixes them freely with agent events. */
export type PipelineRunEventType =
  | "run_started"
  | "step_started"
  | "step_completed"
  | "run_completed"
  | "run_failed"
  | "run_interrupted";

/** Milestone events are retained forever; everything else is prunable. Keeping
 *  step_completed (per-agent outcome) preserves a run's shape long-term; only
 *  step_started (and any future step_progress) is treated as prunable detail. */
export const PIPELINE_MILESTONE_EVENT_TYPES = [
  "run_started",
  "run_completed",
  "run_failed",
  "run_interrupted",
  "step_completed",
] as const;

export interface PipelineEventInput {
  type: PipelineRunEventType;
  /** Agent id for step_* events; omit for run_* events. */
  stepName?: string | null;
  message: string;
  count?: number | null;
  payload?: unknown;
}

/** A minimal handle to the run an event belongs to. */
export interface PipelineRunRef {
  id: string;
  tenantId: string;
}

/** Postgres unique_violation. Emits fire concurrently (callers `void` them), so
 *  two inserts for the same run can compute the same MAX(seq)+1 and collide on
 *  UNIQUE(run_id, seq). That's expected under concurrency — we retry rather than
 *  drop the event. */
const PG_UNIQUE_VIOLATION = "23505";
const EMIT_MAX_ATTEMPTS = 6;

/**
 * Persist one pipeline-run event. Best-effort: a failure is logged and swallowed
 * so it can never break or slow the run that emitted it. `seq` is computed inside
 * the INSERT (MAX(seq)+1 for the run) so ordering is correct without a round-trip.
 *
 * Concurrency-safe: because callers fire-and-forget (`void`), several emits for
 * the SAME run can be in flight at once and race on the computed seq. On a
 * UNIQUE(run_id, seq) collision we retry (the subquery recomputes a fresh
 * MAX(seq)+1 each attempt), so a losing racer takes the next slot instead of
 * silently dropping the event — the whole point of a durable audit trail.
 */
export async function emitPipelineRunEvent(
  run: PipelineRunRef,
  event: PipelineEventInput,
): Promise<void> {
  for (let attempt = 1; attempt <= EMIT_MAX_ATTEMPTS; attempt++) {
    try {
      await dbAdmin.insert(pipelineRunEventsTable).values({
        tenantId: run.tenantId,
        runId: run.id,
        seq: sql`(SELECT COALESCE(MAX(seq), 0) + 1 FROM pipeline_run_events WHERE run_id = ${run.id})`,
        type: event.type,
        stepName: event.stepName ?? null,
        message: event.message,
        count: event.count ?? null,
        payload: (event.payload as any) ?? null,
      });
      return;
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === PG_UNIQUE_VIOLATION && attempt < EMIT_MAX_ATTEMPTS) {
        // seq collision with a concurrent emit for the same run — retry with a
        // freshly recomputed seq (tiny jittered backoff to de-sync the racers).
        await new Promise((r) => setTimeout(r, 5 * attempt + Math.floor(Math.random() * 5)));
        continue;
      }
      // Never rethrow — the run must not care whether its audit line persisted.
      logger.error({ err, runId: run.id, type: event.type, attempt }, "[pipeline-runs] emitPipelineRunEvent failed");
      return;
    }
  }
}

export interface PruneResult {
  deleted: number;
  batches: number;
  moreRemaining: boolean;
  error?: string;
}

/**
 * Delete non-milestone pipeline_run_events older than `retentionDays`, in batches
 * so a large backlog never locks the table. Milestone events are kept forever.
 * Best-effort: returns {error} rather than throwing.
 */
export async function prunePipelineRunEvents(opts: {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}): Promise<PruneResult> {
  const retentionDays = opts.retentionDays;
  const batchSize = opts.batchSize ?? 5_000;
  const maxBatches = opts.maxBatches ?? 100;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000);

  let deleted = 0;
  let batches = 0;
  let moreRemaining = false;

  try {
    for (let i = 0; i < maxBatches; i++) {
      const res: any = await dbAdmin.execute(sql`
        WITH doomed AS (
          SELECT id FROM pipeline_run_events
           WHERE "timestamp" < ${cutoff}
             AND type NOT IN ('run_started','run_completed','run_failed','run_interrupted','step_completed')
           LIMIT ${batchSize}
        )
        DELETE FROM pipeline_run_events e
         USING doomed d
         WHERE e.id = d.id
      `);
      const n = (res?.rowCount ?? res?.count ?? (Array.isArray(res) ? res.length : 0)) as number;
      deleted += n;
      batches += 1;
      if (n < batchSize) break;
      if (i === maxBatches - 1) moreRemaining = true;
    }
    return { deleted, batches, moreRemaining };
  } catch (err: any) {
    logger.warn({ err: err?.message, retentionDays }, "[pipeline-runs] prunePipelineRunEvents failed");
    return { deleted, batches, moreRemaining, error: err?.message ?? "prune failed" };
  }
}
