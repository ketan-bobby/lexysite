/**
 * lib/agent-runs/recorder.ts — Agent Run recorder
 *
 * The single write path for the Agent Run event model. Both the real sourcing
 * pipeline and `simulateSourcingRun` call these helpers, so the persisted shape
 * (and therefore the UI contract) is identical regardless of the source.
 *
 * ── Why dbAdmin ──────────────────────────────────────────────────────────────
 * A simulated run continues emitting events for ~20s AFTER the HTTP request that
 * started it has responded. By then the request-scoped lexy_app connection (and
 * its tenant GUCs) is gone, so writes must use the BYPASSRLS admin pool. Every
 * insert here sets tenant_id explicitly, and all READS still go through the
 * tenant-scoped `db` role in the routes — so isolation is preserved.
 */
import { dbAdmin, agentRunsTable, agentRunEventsTable } from "@workspace/db";
import { and, eq, sql, inArray } from "drizzle-orm";
import type { AgentRunStatus, RunEventType } from "@workspace/db";
import { logger } from "../logger";

/**
 * A single fixed key for the transaction advisory lock that serializes run
 * starts (see `startGuardedAgentRun`). Any constant works as long as it is used
 * consistently; this one is arbitrary and namespaced to agent runs.
 */
const RUN_START_LOCK_KEY = 4915_0001;

/** The statuses that occupy the in-process executor. */
const ACTIVE_STATUSES = ["queued", "running"] as const;

export interface CreateRunInput {
  tenantId: string;
  workOrderId: string;
  agentType?: string;
  isSimulated?: boolean;
  triggeredBy?: string;
  status?: AgentRunStatus;
}

export async function createAgentRun(input: CreateRunInput) {
  const [run] = await dbAdmin
    .insert(agentRunsTable)
    .values({
      tenantId: input.tenantId,
      workOrderId: input.workOrderId,
      agentType: input.agentType ?? "sourcing",
      isSimulated: input.isSimulated ?? false,
      triggeredBy: input.triggeredBy ?? "user",
      status: input.status ?? "running",
      startedAt: new Date(),
    })
    .returning();
  return run;
}

export type StartRunResult =
  | { ok: true; run: Awaited<ReturnType<typeof createAgentRun>> }
  | { ok: false; code: "run_in_progress"; runId: string }
  | { ok: false; code: "global_run_limit" };

/**
 * Atomically enforce both concurrency caps and insert the run, so two parallel
 * start requests can't both slip past a check-then-insert race:
 *   • per work order — at most ONE active (queued|running) sourcing run
 *   • globally       — at most `maxConcurrent` active runs across ALL tenants
 *
 * A transaction-scoped advisory lock serializes all run-starts (they're
 * infrequent and quick), so the counts read inside are authoritative for the
 * insert. Uses dbAdmin because the count must see every tenant's runs and the
 * caller has already authorized the work order.
 */
export async function startGuardedAgentRun(
  input: CreateRunInput,
  opts: { maxConcurrent: number },
): Promise<StartRunResult> {
  return await dbAdmin.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${RUN_START_LOCK_KEY})`);

    const agentType = input.agentType ?? "sourcing";

    // Per-work-order: reject if this requisition already has an active run.
    const [existing] = await tx
      .select({ id: agentRunsTable.id })
      .from(agentRunsTable)
      .where(and(
        eq(agentRunsTable.workOrderId, input.workOrderId),
        eq(agentRunsTable.agentType, agentType),
        inArray(agentRunsTable.status, ACTIVE_STATUSES as unknown as string[]),
      ))
      .limit(1);
    if (existing) return { ok: false, code: "run_in_progress", runId: existing.id };

    // Global: reject if the executor is already at capacity server-wide.
    const [{ n: globalActive }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRunsTable)
      .where(inArray(agentRunsTable.status, ACTIVE_STATUSES as unknown as string[]));
    if (globalActive >= opts.maxConcurrent) return { ok: false, code: "global_run_limit" };

    const [run] = await tx
      .insert(agentRunsTable)
      .values({
        tenantId: input.tenantId,
        workOrderId: input.workOrderId,
        agentType,
        isSimulated: input.isSimulated ?? false,
        triggeredBy: input.triggeredBy ?? "user",
        status: input.status ?? "running",
        startedAt: new Date(),
      })
      .returning();
    return { ok: true, run };
  });
}

export interface EmitEventInput {
  type: RunEventType;
  stepName?: string;
  message: string;
  count?: number | null;
  payload?: unknown;
}

/**
 * Append an event to a run. Assigns the next per-run `seq` atomically so the
 * polling endpoint can page by seq, and bumps the run's updated_at so the UI can
 * detect liveness. Best-effort: a failed event write never throws to the caller.
 */
export async function emitRunEvent(
  run: { id: string; tenantId: string },
  event: EmitEventInput,
): Promise<void> {
  // seq = MAX(seq)+1 is computed in-statement; CONCURRENT emitters for the same
  // run can compute the same value and collide on UNIQUE(run_id, seq). Retry on
  // 23505 (unique_violation) with jittered backoff — the subquery recomputes a
  // fresh seq each attempt — so no writer's event is ever silently dropped.
  // (Same pattern as the pipeline_run_events durable stream.)
  // Under a K-way race only one writer wins each round, so a loser can need up
  // to ~K attempts. Collisions are cheap (index lookup + retry), so a generous
  // cap costs nothing in the common case and guarantees no drop under any
  // realistic fan-out.
  const MAX_ATTEMPTS = 40;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await dbAdmin.insert(agentRunEventsTable).values({
        tenantId: run.tenantId,
        runId: run.id,
        seq: sql`(SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_run_events WHERE run_id = ${run.id})`,
        type: event.type,
        stepName: event.stepName ?? null,
        message: event.message,
        count: event.count ?? null,
        payload: (event.payload as any) ?? null,
      });
      break; // inserted
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === "23505" && attempt < MAX_ATTEMPTS) {
        // Small jitter so racing writers don't re-collide in lockstep.
        await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 40));
        continue;
      }
      logger.error({ err, attempt }, "[agent-runs] emitRunEvent failed");
      return; // best-effort: never throw to the caller
    }
  }
  try {
    await dbAdmin
      .update(agentRunsTable)
      .set({ updatedAt: new Date() })
      .where(eq(agentRunsTable.id, run.id));
  } catch (err) {
    logger.error({ err }, "[agent-runs] emitRunEvent liveness bump failed");
  }
}

export interface PruneResult {
  deleted: number;
  batches: number;
  moreRemaining: boolean;
  error?: string;
}

/**
 * Delete non-milestone agent_run_events older than `retentionDays`, in batches
 * so a large backlog never locks the table. Mirrors prunePipelineRunEvents:
 * milestone events (run_completed/run_failed + step_completed) define a run's
 * durable audit shape and are kept forever; step_started/step_progress detail
 * is only useful while recent. Best-effort: returns {error} rather than throwing.
 */
export async function pruneAgentRunEvents(opts: {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}): Promise<PruneResult> {
  const batchSize = opts.batchSize ?? 5_000;
  const maxBatches = opts.maxBatches ?? 100;
  const cutoff = new Date(Date.now() - opts.retentionDays * 24 * 60 * 60_000);

  let deleted = 0;
  let batches = 0;
  let moreRemaining = false;

  try {
    for (let i = 0; i < maxBatches; i++) {
      const res: any = await dbAdmin.execute(sql`
        WITH doomed AS (
          SELECT id FROM agent_run_events
           WHERE "timestamp" < ${cutoff}
             AND type NOT IN ('run_completed','run_failed','step_completed')
           LIMIT ${batchSize}
        )
        DELETE FROM agent_run_events e
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
    logger.warn(
      { err: err?.message, retentionDays: opts.retentionDays },
      "[agent-runs] pruneAgentRunEvents failed",
    );
    return { deleted, batches, moreRemaining, error: err?.message ?? "prune failed" };
  }
}

/** Merge counters into the run.summary jsonb (found / screened / shortlisted…). */
export async function updateRunSummary(
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    await dbAdmin
      .update(agentRunsTable)
      .set({ summary: sql`COALESCE(summary, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
      .where(eq(agentRunsTable.id, runId));
  } catch (err) {
    logger.error({ err }, "[agent-runs] updateRunSummary failed");
  }
}

/**
 * True when a run has been cancelled (or otherwise reached a terminal status).
 * The fire-and-forget simulate loop polls this between stages so a recruiter's
 * Cancel takes effect promptly without a running-run registry. Best-effort:
 * on a transient read error we return false and let the loop continue.
 */
export async function isRunCancelled(runId: string): Promise<boolean> {
  try {
    const [row] = await dbAdmin
      .select({ status: agentRunsTable.status })
      .from(agentRunsTable)
      .where(eq(agentRunsTable.id, runId))
      .limit(1);
    return row?.status === "cancelled";
  } catch (err) {
    logger.error({ err }, "[agent-runs] isRunCancelled failed");
    return false;
  }
}

/**
 * Set a run's terminal status — but ONLY if it is still active. Guarding on
 * status is what makes Cancel authoritative: once the cancel endpoint sets
 * `cancelled`, the fire-and-forget simulate loop's own `completeAgentRun(…,
 * "completed")` near the finish line is a no-op and cannot overwrite it. Same
 * for the reverse. Best-effort (never throws to the caller).
 */
export async function completeAgentRun(
  runId: string,
  status: Extract<AgentRunStatus, "completed" | "failed" | "cancelled">,
  error?: string,
): Promise<void> {
  try {
    await dbAdmin
      .update(agentRunsTable)
      .set({ status, error: error ?? null, completedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(agentRunsTable.id, runId),
        inArray(agentRunsTable.status, ACTIVE_STATUSES as unknown as string[]),
      ));
  } catch (err) {
    logger.error({ err }, "[agent-runs] completeAgentRun failed");
  }
}

/**
 * Runs execute in-process (fire-and-forget), so a process restart mid-run leaves
 * rows stuck in `queued`/`running` forever — an in-memory executor can never
 * resume them. On boot we reconcile any such orphans to `failed` with a terminal
 * event so the audit trail is honest and the UI stops spinning. Best-effort.
 */
export async function reconcileStaleAgentRuns(): Promise<void> {
  try {
    const stale = await dbAdmin
      .update(agentRunsTable)
      .set({
        status: "failed",
        error: "Run interrupted by a server restart",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(agentRunsTable.status, ["queued", "running"]))
      .returning({ id: agentRunsTable.id, tenantId: agentRunsTable.tenantId });

    for (const run of stale) {
      await emitRunEvent(run, {
        type: "run_failed",
        message: "Run interrupted by a server restart",
      });
    }
    if (stale.length > 0) {
      logger.info({ count: stale.length }, "[agent-runs] reconciled stale runs on boot");
    }
  } catch (err) {
    logger.error({ err }, "[agent-runs] reconcileStaleAgentRuns failed");
  }
}
