/**
 * http-access-log-retention-scheduler.ts — Automatic pruning of old
 * http_access_logs rows.
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 * Every completed HTTP request persists one row to `http_access_logs` (see
 * lib/http-access-log.ts). Access logs are only useful while recent, so this
 * scheduler periodically deletes rows older than a configurable window
 * (default 30 days) to keep the table small.
 *
 * The actual deletion lives in lib/http-access-log.ts (pruneHttpAccessLogs) —
 * batched, self-limiting, and best-effort (a DB failure is reported, never
 * thrown). This file just owns the recurring schedule, mirroring the other
 * api-server retention schedulers (heartbeat + setInterval + leader election
 * in index.ts).
 *
 * ─── Tuning (all env vars, all optional with sane defaults) ───────────────────
 *   HTTP_ACCESS_LOG_RETENTION_DAYS            keep rows newer than   (default 30 days)
 *   HTTP_ACCESS_LOG_RETENTION_INTERVAL_HOURS  how often to prune     (default 24h)
 *   HTTP_ACCESS_LOG_RETENTION_BATCH_SIZE      rows deleted per DELETE(default 5,000)
 *   HTTP_ACCESS_LOG_RETENTION_MAX_BATCHES     max DELETEs per tick   (default 100)
 *
 * The heartbeat name is "http_access_log_retention".
 */
import { pruneHttpAccessLogs } from "./http-access-log.js";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";

/** Read a positive numeric env var, falling back on missing / invalid / <= 0
 *  values. The floor matters: a mis-set HTTP_ACCESS_LOG_RETENTION_DAYS=0 would
 *  otherwise set the prune cutoff to "now" and wipe the whole table. */
function posEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RETENTION_DAYS = posEnv("HTTP_ACCESS_LOG_RETENTION_DAYS", 30);
const INTERVAL_MS = posEnv("HTTP_ACCESS_LOG_RETENTION_INTERVAL_HOURS", 24) * 60 * 60_000;
const BATCH_SIZE = posEnv("HTTP_ACCESS_LOG_RETENTION_BATCH_SIZE", 5_000);
const MAX_BATCHES = posEnv("HTTP_ACCESS_LOG_RETENTION_MAX_BATCHES", 100);

async function tick(): Promise<void> {
  const result = await pruneHttpAccessLogs({
    retentionDays: RETENTION_DAYS,
    batchSize: BATCH_SIZE,
    maxBatches: MAX_BATCHES,
  });

  if (result.error) {
    logger.warn(
      { evt: "http_access_log_retention", ...result, retentionDays: RETENTION_DAYS },
      "[http-access-log-retention] prune completed with errors",
    );
    return;
  }

  if (result.deleted > 0 || result.moreRemaining) {
    logger.info(
      { evt: "http_access_log_retention", ...result, retentionDays: RETENTION_DAYS },
      `[http-access-log-retention] pruned ${result.deleted} access-log row(s) older than ${RETENTION_DAYS}d` +
        (result.moreRemaining ? " (more remain — will continue next tick)" : ""),
    );
  }
}

export function startHttpAccessLogRetentionScheduler(): void {
  logger.info(
    {
      retentionDays: RETENTION_DAYS,
      intervalHours: INTERVAL_MS / 60 / 60_000,
      batchSize: BATCH_SIZE,
      maxBatches: MAX_BATCHES,
    },
    `[http-access-log-retention-scheduler] Started — prunes every ${INTERVAL_MS / 60 / 60_000}h, keeps ${RETENTION_DAYS}d`,
  );

  const run = () =>
    tick()
      .then(() => heartbeat("http_access_log_retention"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[http-access-log-retention] tick failed");
        heartbeat("http_access_log_retention", "fail", err);
      });

  /* Run once shortly after boot (delayed so it never competes with startup
     work), then on the recurring schedule. */
  setTimeout(run, 60_000);
  setInterval(run, INTERVAL_MS);
}
