/**
 * pipeline-run-events-retention-scheduler.ts — Automatic pruning of old
 * pipeline_run_events rows.
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 * Every pipeline run persists a handful of lifecycle events to the
 * `pipeline_run_events` table (see lib/pipeline-runs/recorder.ts →
 * emitPipelineRunEvent). Milestone events (run_started/completed/failed/
 * interrupted + step_completed) are kept forever because they define a run's
 * durable audit shape; non-milestone detail (step_started, future step_progress)
 * is only useful while recent. This scheduler periodically deletes non-milestone
 * rows older than a configurable window so the table stays small.
 *
 * The actual deletion lives in lib/pipeline-runs/recorder.ts (prunePipelineRunEvents)
 * — batched, self-limiting, and best-effort (a DB failure is reported, never
 * thrown). This file just owns the recurring schedule, mirroring the other
 * api-server schedulers (heartbeat + setInterval + leader election in index.ts).
 *
 * ─── Tuning (all env vars, all optional with sane defaults) ───────────────────
 *   PIPELINE_EVENTS_RETENTION_DAYS            keep non-milestone rows newer than  (default 90 days)
 *   PIPELINE_EVENTS_RETENTION_INTERVAL_HOURS  how often to prune                  (default 24h)
 *   PIPELINE_EVENTS_RETENTION_BATCH_SIZE      rows deleted per DELETE             (default 5,000)
 *   PIPELINE_EVENTS_RETENTION_MAX_BATCHES     max DELETEs per tick                (default 100)
 *
 * The heartbeat name is "pipeline_events_retention".
 */
import { prunePipelineRunEvents } from "./pipeline-runs/recorder.js";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const RETENTION_DAYS = numEnv("PIPELINE_EVENTS_RETENTION_DAYS", 90);
const INTERVAL_MS = numEnv("PIPELINE_EVENTS_RETENTION_INTERVAL_HOURS", 24) * 60 * 60_000;
const BATCH_SIZE = numEnv("PIPELINE_EVENTS_RETENTION_BATCH_SIZE", 5_000);
const MAX_BATCHES = numEnv("PIPELINE_EVENTS_RETENTION_MAX_BATCHES", 100);

async function tick(): Promise<void> {
  const result = await prunePipelineRunEvents({
    retentionDays: RETENTION_DAYS,
    batchSize: BATCH_SIZE,
    maxBatches: MAX_BATCHES,
  });

  if (result.error) {
    logger.warn(
      { evt: "pipeline_events_retention", ...result, retentionDays: RETENTION_DAYS },
      "[pipeline-events-retention] prune completed with errors",
    );
    return;
  }

  if (result.deleted > 0 || result.moreRemaining) {
    logger.info(
      { evt: "pipeline_events_retention", ...result, retentionDays: RETENTION_DAYS },
      `[pipeline-events-retention] pruned ${result.deleted} pipeline event(s) older than ${RETENTION_DAYS}d` +
        (result.moreRemaining ? " (more remain — will continue next tick)" : ""),
    );
  }
}

export function startPipelineRunEventsRetentionScheduler(): void {
  logger.info(
    {
      retentionDays: RETENTION_DAYS,
      intervalHours: INTERVAL_MS / 60 / 60_000,
      batchSize: BATCH_SIZE,
      maxBatches: MAX_BATCHES,
    },
    `[pipeline-events-retention-scheduler] Started — prunes every ${INTERVAL_MS / 60 / 60_000}h, keeps non-milestone ${RETENTION_DAYS}d`,
  );

  const run = () =>
    tick()
      .then(() => heartbeat("pipeline_events_retention"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[pipeline-events-retention] tick failed");
        heartbeat("pipeline_events_retention", "fail", err);
      });

  /* Run once shortly after boot (delayed so it never competes with startup work),
     then on the recurring schedule. */
  setTimeout(run, 60_000);
  setInterval(run, INTERVAL_MS);
}
