/**
 * history-retention-scheduler.ts — Automatic pruning of remaining unbounded
 * history tables (backlog: "apply the same automatic cleanup to other history
 * tables").
 *
 * ─── What this prunes ────────────────────────────────────────────────────────
 * 1. `agent_run_events` — the sourcing-agent live-progress stream. The direct
 *    analog of pipeline_run_events (which already has retention): milestone
 *    events (run_completed/run_failed + step_completed) are kept forever
 *    because they define a run's durable audit shape; step_started /
 *    step_progress chatter is only useful while recent. Deletion lives in
 *    lib/agent-runs/recorder.ts (pruneAgentRunEvents), batched + best-effort.
 * 2. `system_errors` — client/server error telemetry appended on every
 *    reported error (app.ts) and only read as recent-history admin data.
 *
 * Deliberately NOT pruned (compliance / audit trails, keep forever):
 * candidate_events, decision_events, communication_events, candidate outcome
 * and consent history, fee ledger — those are legal-record surfaces (EU AI
 * Act / GDPR accountability), not operational chatter.
 *
 * ─── Tuning (env vars, optional) ─────────────────────────────────────────────
 *   AGENT_EVENTS_RETENTION_DAYS      keep non-milestone agent run events   (default 90)
 *   SYSTEM_ERRORS_RETENTION_DAYS     keep error telemetry rows             (default 90)
 *   HISTORY_RETENTION_INTERVAL_HOURS how often to prune                    (default 24)
 *
 * Heartbeat name: "history_retention".
 */
import { sql } from "drizzle-orm";
import { dbAdmin } from "@workspace/db";
import { pruneAgentRunEvents } from "./agent-runs/recorder.js";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const AGENT_EVENTS_DAYS = numEnv("AGENT_EVENTS_RETENTION_DAYS", 90);
const SYSTEM_ERRORS_DAYS = numEnv("SYSTEM_ERRORS_RETENTION_DAYS", 90);
const INTERVAL_MS = numEnv("HISTORY_RETENTION_INTERVAL_HOURS", 24) * 60 * 60_000;
const BATCH_SIZE = 5_000;
const MAX_BATCHES = 100;

/** Batched, best-effort prune of system_errors older than the window. */
async function pruneSystemErrors(): Promise<{ deleted: number; error?: string }> {
  const cutoff = new Date(Date.now() - SYSTEM_ERRORS_DAYS * 24 * 60 * 60_000);
  let deleted = 0;
  try {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const res: any = await dbAdmin.execute(sql`
        WITH doomed AS (
          SELECT id FROM system_errors WHERE occurred_at < ${cutoff} LIMIT ${BATCH_SIZE}
        )
        DELETE FROM system_errors e USING doomed d WHERE e.id = d.id
      `);
      const n = (res?.rowCount ?? res?.count ?? 0) as number;
      deleted += n;
      if (n < BATCH_SIZE) break;
    }
    return { deleted };
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[history-retention] pruneSystemErrors failed");
    return { deleted, error: err?.message ?? "prune failed" };
  }
}

async function tick(): Promise<void> {
  const agentEvents = await pruneAgentRunEvents({
    retentionDays: AGENT_EVENTS_DAYS,
    batchSize: BATCH_SIZE,
    maxBatches: MAX_BATCHES,
  });
  const systemErrors = await pruneSystemErrors();

  if (
    agentEvents.deleted > 0 ||
    systemErrors.deleted > 0 ||
    agentEvents.error ||
    systemErrors.error
  ) {
    logger.info(
      {
        evt: "history_retention",
        agentEventsDeleted: agentEvents.deleted,
        agentEventsError: agentEvents.error ?? null,
        systemErrorsDeleted: systemErrors.deleted,
        systemErrorsError: systemErrors.error ?? null,
      },
      `[history-retention] pruned ${agentEvents.deleted} agent event(s) >${AGENT_EVENTS_DAYS}d, ${systemErrors.deleted} system error(s) >${SYSTEM_ERRORS_DAYS}d`,
    );
  }
}

export function startHistoryRetentionScheduler(): void {
  logger.info(
    {
      agentEventsDays: AGENT_EVENTS_DAYS,
      systemErrorsDays: SYSTEM_ERRORS_DAYS,
      intervalHours: INTERVAL_MS / 60 / 60_000,
    },
    `[history-retention-scheduler] Started — prunes every ${INTERVAL_MS / 60 / 60_000}h`,
  );

  const run = () =>
    tick()
      .then(() => heartbeat("history_retention"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[history-retention] tick failed");
        heartbeat("history_retention", "fail", err);
      });

  /* Run once shortly after boot (delayed so it never competes with startup work),
     then on the recurring schedule. */
  setTimeout(run, 90_000);
  setInterval(run, INTERVAL_MS);
}
