/**
 * stt-retention-scheduler.ts — Automatic pruning of old STT transcription history.
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 * Every /interviews/transcribe request persists one row to the
 * `stt_transcribe_events` table (see lib/stt-metrics.ts → persistSttEvent). With
 * real interview volume that table grows without bound, even though we only ever
 * query recent history for trend review (getSttTrends defaults to 30 days, caps
 * at 365). This scheduler periodically deletes rows older than a configurable
 * retention window so storage and query costs stay flat.
 *
 * The actual deletion lives in stt-metrics.ts (pruneSttEvents) — batched,
 * self-limiting, and best-effort (a DB failure is reported, never thrown). This
 * file just owns the recurring schedule, mirroring the other api-server
 * schedulers (heartbeat + setInterval + leader election in index.ts).
 *
 * ─── Tuning (all env vars, all optional with sane defaults) ───────────────────
 *   STT_RETENTION_DAYS            keep rows newer than this   (default 365 days — EU AI Act Art. 12 logging window)
 *   STT_RETENTION_INTERVAL_HOURS  how often to prune          (default 24h)
 *   STT_RETENTION_BATCH_SIZE      rows deleted per DELETE      (default 5,000)
 *   STT_RETENTION_MAX_BATCHES     max DELETEs per tick         (default 100)
 *
 * The heartbeat name is "stt_retention".
 */
import { pruneSttEvents } from "./stt-metrics.js";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const RETENTION_DAYS = numEnv("STT_RETENTION_DAYS", 365);
const INTERVAL_MS = numEnv("STT_RETENTION_INTERVAL_HOURS", 24) * 60 * 60_000;
const BATCH_SIZE = numEnv("STT_RETENTION_BATCH_SIZE", 5_000);
const MAX_BATCHES = numEnv("STT_RETENTION_MAX_BATCHES", 100);

async function tick(): Promise<void> {
  const result = await pruneSttEvents({
    retentionDays: RETENTION_DAYS,
    batchSize: BATCH_SIZE,
    maxBatches: MAX_BATCHES,
  });

  if (result.error) {
    // pruneSttEvents already logged the warning; surface a tick-level note too.
    logger.warn(
      { evt: "stt_retention", ...result, retentionDays: RETENTION_DAYS },
      "[stt-retention] prune completed with errors",
    );
    return;
  }

  if (result.deleted > 0 || result.moreRemaining) {
    logger.info(
      { evt: "stt_retention", ...result, retentionDays: RETENTION_DAYS },
      `[stt-retention] pruned ${result.deleted} transcribe event(s) older than ${RETENTION_DAYS}d` +
        (result.moreRemaining ? " (more remain — will continue next tick)" : ""),
    );
  }
}

export function startSttRetentionScheduler(): void {
  logger.info(
    {
      retentionDays: RETENTION_DAYS,
      intervalHours: INTERVAL_MS / 60 / 60_000,
      batchSize: BATCH_SIZE,
      maxBatches: MAX_BATCHES,
    },
    `[stt-retention-scheduler] Started — prunes every ${INTERVAL_MS / 60 / 60_000}h, keeps ${RETENTION_DAYS}d`,
  );

  const run = () =>
    tick()
      .then(() => heartbeat("stt_retention"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[stt-retention] tick failed");
        heartbeat("stt_retention", "fail", err);
      });

  /* Run once shortly after boot so a long-lived process that rarely restarts
     doesn't wait a full interval before its first cleanup, then on the recurring
     schedule. Delayed a little so it never competes with startup work. */
  setTimeout(run, 60_000);
  setInterval(run, INTERVAL_MS);
}
