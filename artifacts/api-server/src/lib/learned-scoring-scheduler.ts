/**
 * learned-scoring-scheduler.ts — automatic refresh of per-tenant learned
 * scoring weights as new hire outcomes arrive (backlog: "Automatically refresh
 * learned scoring as new hire outcomes arrive").
 *
 * Previously trainTenantWeights() only ran when an admin called the manual
 * POST /learning/tenant-weights/train route, so learned configs went stale as
 * outcomes accrued. This scheduler runs daily (leader-only, mirroring the
 * other 24h schedulers) and re-trains ONLY tenants with at least one labeled
 * outcome recorded AFTER their most recent training attempt (any version row,
 * active or rejected — a rejected run still evaluated that data). All the
 * safety stays in trainTenantWeights itself: the MIN_SAMPLES gate and the
 * backtest-win requirement mean a refresh can never promote a worse config —
 * losers are recorded inactive and the tenant keeps its current behavior.
 *
 * Env knobs:
 *   LEARNED_SCORING_REFRESH_INTERVAL_HOURS (default 24)
 *   LEARNED_SCORING_REFRESH_DISABLED=true  to turn off
 */
import { dbAdmin, candidateJobIntelligenceTable, tenantScoringWeightsTable } from "@workspace/db";
import { sql, isNotNull } from "drizzle-orm";
import { trainTenantWeights } from "./learned-scoring";
import { trainGlobalPrior } from "./global-prior";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";
import { logger } from "./logger";

const INTERVAL_HOURS = Number(process.env.LEARNED_SCORING_REFRESH_INTERVAL_HOURS ?? 24) || 24;
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;

/**
 * Tenants whose labeled-outcome set changed since their last training attempt:
 * has ≥1 row with a non-null outcome whose outcomeAt (or lastUpdated when
 * outcomeAt is null) is AFTER the tenant's newest tenant_scoring_weights row
 * (never-trained tenants qualify whenever they have any labeled row).
 * Exported for the integration test.
 */
export async function findTenantsNeedingRetrain(): Promise<string[]> {
  /* Cross-tenant by design: a platform scheduler enumerating WHICH tenants have
   * new labeled outcomes. Reads only tenantId + timestamps (no candidate data);
   * the training itself is strictly per-tenant inside trainTenantWeights. */
  classBRead(CLASS_B_READ_EXEMPTION.CROSS_TENANT_MODEL_TRAINING);
  const rows = await dbAdmin
    .select({
      tenantId: candidateJobIntelligenceTable.tenantId,
      latestOutcome: sql<
        string | null
      >`max(coalesce(${candidateJobIntelligenceTable.outcomeAt}, ${candidateJobIntelligenceTable.lastUpdated}))`,
      lastTrained: sql<
        string | null
      >`(select max(w.created_at) from tenant_scoring_weights w where w.tenant_id = ${candidateJobIntelligenceTable.tenantId})`,
    })
    .from(candidateJobIntelligenceTable)
    .where(isNotNull(candidateJobIntelligenceTable.outcome))
    .groupBy(candidateJobIntelligenceTable.tenantId);

  return rows
    .filter((r) => {
      if (!r.latestOutcome) return false;
      if (!r.lastTrained) return true;
      return new Date(r.latestOutcome).getTime() > new Date(r.lastTrained).getTime();
    })
    .map((r) => r.tenantId);
}

let refreshInProgress = false;

/** One refresh pass. Exported for the manual admin trigger / tests. */
export async function runLearnedScoringRefresh(): Promise<{
  tenantsConsidered: number;
  promoted: number;
  rejected: number;
  insufficient: number;
  failed: number;
  globalPriorStatus: string | null;
}> {
  const result = {
    tenantsConsidered: 0,
    promoted: 0,
    rejected: 0,
    insufficient: 0,
    failed: 0,
    globalPriorStatus: null as string | null,
  };
  if (refreshInProgress) return result;
  refreshInProgress = true;
  try {
    const tenants = await findTenantsNeedingRetrain();
    result.tenantsConsidered = tenants.length;
    for (const tenantId of tenants) {
      try {
        const r = await trainTenantWeights(tenantId);
        if (r.status === "promoted") result.promoted++;
        else if (r.status === "rejected_by_backtest") result.rejected++;
        else result.insufficient++;
      } catch (err: any) {
        result.failed++;
        logger.warn({ err: err?.message, tenantId }, "[learned-refresh] tenant retrain failed");
      }
    }
    /* #38 — refresh the cross-customer meta-prior on the same cadence, but only
     * when at least one tenant had new outcomes (nothing changed otherwise).
     * trainGlobalPrior carries its own gates (min tenants/samples, federated
     * eval win) so a scheduled run can never promote a worse prior. */
    if (tenants.length > 0 && process.env.GLOBAL_PRIOR_REFRESH_DISABLED !== "true") {
      try {
        const gp = await trainGlobalPrior();
        result.globalPriorStatus = gp.status;
      } catch (err: any) {
        result.globalPriorStatus = "failed";
        logger.warn({ err: err?.message }, "[learned-refresh] global-prior refresh failed");
      }
    }
    if (tenants.length > 0) {
      logger.info(result, "[learned-refresh] refresh pass complete");
    }
    return result;
  } finally {
    refreshInProgress = false;
  }
}

export function startLearnedScoringRefreshScheduler(): void {
  if (process.env.LEARNED_SCORING_REFRESH_DISABLED === "true") {
    logger.info("[learned-refresh] disabled via LEARNED_SCORING_REFRESH_DISABLED");
    return;
  }
  logger.info(
    { intervalHours: INTERVAL_HOURS },
    "[learned-refresh] Started — retrains tenants with new outcomes",
  );
  setTimeout(() => {
    void runLearnedScoringRefresh().catch((err) =>
      logger.error({ err: err?.message }, "[learned-refresh] first pass failed"),
    );
    setInterval(
      () => {
        void runLearnedScoringRefresh().catch((err) =>
          logger.error({ err: err?.message }, "[learned-refresh] pass failed"),
        );
      },
      INTERVAL_HOURS * 60 * 60 * 1000,
    );
  }, FIRST_RUN_DELAY_MS);
}
