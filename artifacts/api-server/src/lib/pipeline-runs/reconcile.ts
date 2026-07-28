/**
 * lib/pipeline-runs/reconcile.ts — Boot-time reconciliation for pipeline_runs
 *
 * Pipeline runs execute in-process (fire-and-forget via setImmediate in
 * routes/agents.ts + routes/pipeline.ts). A process restart — most commonly a
 * deploy — mid-run leaves the row stuck in `running`/`queued` forever, because
 * no in-memory executor survives to stamp its terminal status. On boot we
 * reconcile such orphans so the audit trail terminates honestly and the UI
 * stops showing them as live.
 *
 * ── Why a DISTINCT terminal status ("interrupted") ──────────────────────────
 * A deploy interruption is NOT an agent failure. Marking these `failed` would
 * pollute failure-rate reporting and any failure alerting with infrastructure
 * events. `interrupted` keeps them out of failure metrics while still being a
 * terminal, non-spinning state. (The sibling agent_runs reconcile uses `failed`
 * for historical reasons; pipeline_runs deliberately does not.)
 *
 * ── Why a threshold ─────────────────────────────────────────────────────────
 * We only flip runs whose started_at is older than STALE_PIPELINE_RUN_MINUTES.
 * Real pipeline runs finish in seconds-to-minutes, so anything still `running`
 * past the threshold is certainly dead. The threshold is a safety margin so a
 * run that is legitimately starting up concurrently with boot (or, in a future
 * multi-replica setup, one owned by another live replica) is never clobbered.
 *
 * ── Why dbAdmin ─────────────────────────────────────────────────────────────
 * Runs on boot with no request/tenant context, so it must use the BYPASSRLS
 * admin pool (there are no tenant GUCs to scope the update). Best-effort: a
 * failure here never throws to the boot sequence.
 */
import { dbAdmin, pipelineRunsTable } from "@workspace/db";
import { and, inArray, lt } from "drizzle-orm";
import { logger } from "../logger";
import { emitPipelineRunEvent } from "./recorder";

/** A pipeline run still active past this many minutes is treated as orphaned. */
export const STALE_PIPELINE_RUN_MINUTES = 15;

/**
 * Flip orphaned (running/queued, older than the threshold) pipeline runs to the
 * terminal `interrupted` status. Returns the number of rows reconciled.
 */
export async function reconcileStalePipelineRuns(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - STALE_PIPELINE_RUN_MINUTES * 60_000);
    const reconciled = await dbAdmin
      .update(pipelineRunsTable)
      .set({
        status: "interrupted",
        error: "Run interrupted by a server restart",
        completedAt: new Date(),
      })
      .where(and(
        inArray(pipelineRunsTable.status, ["running", "queued"]),
        lt(pipelineRunsTable.startedAt, cutoff),
      ))
      .returning({ id: pipelineRunsTable.id, tenantId: pipelineRunsTable.tenantId });

    if (reconciled.length > 0) {
      logger.info(
        { count: reconciled.length, staleMinutes: STALE_PIPELINE_RUN_MINUTES },
        "[pipeline-runs] reconciled interrupted runs on boot",
      );
      /* Record the interruption on the durable event stream too, so the run's
       * audit trail ends with a run_interrupted milestone rather than dangling at
       * its last step. Best-effort (emit never throws); scoped to the run's tenant. */
      for (const r of reconciled) {
        void emitPipelineRunEvent(
          { id: r.id, tenantId: r.tenantId },
          { type: "run_interrupted", message: "Run interrupted by a server restart" },
        );
      }
    }
    return reconciled.length;
  } catch (err) {
    logger.error({ err }, "[pipeline-runs] reconcileStalePipelineRuns failed");
    return 0;
  }
}
