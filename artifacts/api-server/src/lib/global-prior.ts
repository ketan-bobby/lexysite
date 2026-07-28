/**
 * global-prior.ts — Cross-tenant global scoring prior (network effect)
 *
 * ─── What this closes ────────────────────────────────────────────────────────
 * The per-tenant learned scorer (lib/learned-scoring.ts) shrinks a tenant's four
 * `hireProbability` composite weights toward a PRIOR. Until now that prior was
 * the static hardcoded builtin — so customer #500 cold-starts no smarter than
 * customer #1 did. This module learns a PLATFORM-LEVEL prior from what actually
 * predicts hires across the whole customer base, and feeds it back as the
 * shrink-target / cold-start prior for new and thin-data tenants. That is the
 * compounding data moat: pooled learning, isolated raw data.
 *
 * ─── The isolation guarantee (the whole point) ───────────────────────────────
 * No candidate-level record and no tenant identifier ever crosses a tenant
 * boundary. The ONLY things pooled across tenants are per-dimension SUFFICIENT
 * STATISTICS — `{ n, Σx, Σy, Σx², Σy², Σxy }` for each of fit/quality/trust/
 * conversion vs the binary hire label. Each tenant's labeled rows are loaded,
 * reduced to those six numbers PER DIMENSION inside that tenant's own boundary
 * (see {@link computeTenantAggregate}), and then immediately discarded; only the
 * aggregate numbers are summed across tenants. By construction the pooled type
 * ({@link GlobalAggregate}) has no field that could carry a candidate id, a
 * candidate feature, or a tenant id — the unit tests assert this. Even the
 * activation gate uses a FEDERATED evaluation: each tenant backtests the prior
 * against its OWN rows locally and only scalar metrics (F1, sample count) are
 * aggregated — see {@link evaluateMetaPriorPerTenant}.
 *
 * ─── The safety guarantee ────────────────────────────────────────────────────
 * The static builtin prior is the PERMANENT fallback. A meta-prior only becomes
 * active after clearing (1) a minimum contributing-tenant gate, (2) a minimum
 * total-sample gate, and (3) the federated evaluation (net sample-weighted F1
 * improvement vs builtin). {@link getMetaPrior} NEVER throws — a missing,
 * inactive, below-gate, or malformed row yields null and the caller stays on the
 * builtin/live prior, byte-for-byte identical to today.
 *
 * Pearson recovery from sufficient stats is exact: pooling per-tenant stats and
 * computing the correlation equals computing the correlation over the
 * concatenated rows (proven by {@link poolAggregates} + the unit tests), so the
 * privacy-preserving aggregate loses no information vs a raw pool.
 *
 * Storage is read/written via `controlDb` (cross-tenant platform-admin concern)
 * with explicit per-tenant filters — never a tenant-scoped RLS connection.
 */
import { controlDb, globalScoringPriorsTable, candidateJobIntelligenceTable } from "@workspace/db";
import { eq, isNotNull, desc, sql } from "drizzle-orm";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";
import { logger } from "./logger";
import {
  type ScoringConfig,
  getLiveScoringConfig,
  BUILTIN_LIVE_CONFIG,
} from "./scoring-config";
import {
  loadTenantLabeledRows,
  rowsToDimensionScores,
  type DimensionScoreRow,
} from "./learned-scoring";
import { compareConfigs } from "./backtest";

type HireWeights = ScoringConfig["weights"]["hireProbability"];

/* ── Tunables ─────────────────────────────────────────────────────────────────
 * Read once at module load. Surfaced through the admin status route. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Minimum labeled outcomes a single tenant must have to CONTRIBUTE to the
 *  aggregate. A small-data tenant is excluded so it can neither skew nor be
 *  re-identified from the pooled stats (a light k-anonymity guard). */
export const MIN_TENANT_SAMPLES = envInt("GLOBAL_PRIOR_MIN_TENANT_SAMPLES", 10);
/** Minimum number of contributing tenants before a meta-prior can activate —
 *  a "network effect" needs more than one customer's data. */
export const MIN_CONTRIBUTING_TENANTS = envInt("GLOBAL_PRIOR_MIN_TENANTS", 2);
/** Minimum total pooled labeled outcomes before a meta-prior can activate. */
export const MIN_TOTAL_SAMPLES = envInt("GLOBAL_PRIOR_MIN_TOTAL_SAMPLES", 50);
/** Shrinkage constant K: pooled weights blend λ=N/(N+K) toward the builtin
 *  prior. Larger K ⇒ stays nearer builtin until lots of global data accrues. */
export const SHRINKAGE_K = envInt("GLOBAL_PRIOR_SHRINKAGE_K", 200);
/** Decision threshold used by the per-tenant federated evaluation. */
export const EVAL_THRESHOLD = envInt("GLOBAL_PRIOR_EVAL_THRESHOLD", 50);

/* ── Sufficient statistics (pure, no DB, no identifiers) ──────────────────────
 * Per-dimension running sums sufficient to recover Pearson correlation with the
 * binary hire label. These numbers carry NO candidate or tenant identity. */
export interface DimensionStats {
  n: number;
  sumX: number;   // Σ dimension score
  sumY: number;   // Σ hired (0/1)
  sumXX: number;  // Σ x²
  sumYY: number;  // Σ y²
  sumXY: number;  // Σ x·y
}

export const EMPTY_DIM_STATS: DimensionStats = { n: 0, sumX: 0, sumY: 0, sumXX: 0, sumYY: 0, sumXY: 0 };

/** Fold one (x, y) observation into a dimension's running stats (pure). */
export function accumulate(s: DimensionStats, x: number, y: number): DimensionStats {
  return {
    n: s.n + 1,
    sumX: s.sumX + x,
    sumY: s.sumY + y,
    sumXX: s.sumXX + x * x,
    sumYY: s.sumYY + y * y,
    sumXY: s.sumXY + x * y,
  };
}

/** Element-wise sum of two dimension stats (pure). Pooling is associative, so
 *  per-tenant stats can be merged in any order. */
export function mergeDimStats(a: DimensionStats, b: DimensionStats): DimensionStats {
  return {
    n: a.n + b.n,
    sumX: a.sumX + b.sumX,
    sumY: a.sumY + b.sumY,
    sumXX: a.sumXX + b.sumXX,
    sumYY: a.sumYY + b.sumYY,
    sumXY: a.sumXY + b.sumXY,
  };
}

/** Pearson correlation recovered from sufficient stats; 0 when either series has
 *  zero variance or no samples. Identical (up to fp) to a direct two-pass
 *  Pearson over the raw observations. */
export function pearsonFromStats(s: DimensionStats): number {
  const n = s.n;
  if (n === 0) return 0;
  const covN = s.sumXY - (s.sumX * s.sumY) / n;
  const varXN = s.sumXX - (s.sumX * s.sumX) / n;
  const varYN = s.sumYY - (s.sumY * s.sumY) / n;
  const den = Math.sqrt(varXN * varYN);
  if (!Number.isFinite(den) || den <= 0) return 0;
  const r = covN / den;
  if (!Number.isFinite(r)) return 0;
  return Math.max(-1, Math.min(1, r));
}

/* ── Aggregate shapes (NO identifiers — asserted by the isolation tests) ─────── */

/** A single tenant's contribution: per-dimension sufficient stats + counts.
 *  Deliberately carries NO tenantId/candidateId/name/email — only numbers. */
export interface TenantAggregate {
  sampleSize: number;
  positives: number;
  fit: DimensionStats;
  quality: DimensionStats;
  trust: DimensionStats;
  conversion: DimensionStats;
}

/** The pooled cross-tenant aggregate. Same shape as a tenant aggregate plus a
 *  contributing-tenant count. Still NO identifiers — this is the only object
 *  that spans tenants and it is pure numbers. */
export interface GlobalAggregate {
  contributingTenants: number;
  sampleSize: number;
  positives: number;
  fit: DimensionStats;
  quality: DimensionStats;
  trust: DimensionStats;
  conversion: DimensionStats;
}

export const EMPTY_GLOBAL_AGGREGATE: GlobalAggregate = {
  contributingTenants: 0,
  sampleSize: 0,
  positives: 0,
  fit: { ...EMPTY_DIM_STATS },
  quality: { ...EMPTY_DIM_STATS },
  trust: { ...EMPTY_DIM_STATS },
  conversion: { ...EMPTY_DIM_STATS },
};

/** Reduce one tenant's dimension-score rows to a TenantAggregate (pure). The
 *  rows never leave the caller — only the returned sufficient stats do. */
export function rowsToAggregate(rows: DimensionScoreRow[]): TenantAggregate {
  let fit = { ...EMPTY_DIM_STATS };
  let quality = { ...EMPTY_DIM_STATS };
  let trust = { ...EMPTY_DIM_STATS };
  let conversion = { ...EMPTY_DIM_STATS };
  let positives = 0;
  for (const r of rows) {
    const y = r.hired;
    if (y === 1) positives++;
    fit = accumulate(fit, r.fit, y);
    quality = accumulate(quality, r.quality, y);
    trust = accumulate(trust, r.trust, y);
    conversion = accumulate(conversion, r.conversion, y);
  }
  return { sampleSize: rows.length, positives, fit, quality, trust, conversion };
}

/** Pool many tenant aggregates into one global aggregate (pure). Each input is
 *  one tenant's already-reduced stats; this sums them. */
export function poolAggregates(aggs: TenantAggregate[]): GlobalAggregate {
  let g: GlobalAggregate = {
    ...EMPTY_GLOBAL_AGGREGATE,
    fit: { ...EMPTY_DIM_STATS },
    quality: { ...EMPTY_DIM_STATS },
    trust: { ...EMPTY_DIM_STATS },
    conversion: { ...EMPTY_DIM_STATS },
  };
  for (const a of aggs) {
    g = {
      contributingTenants: g.contributingTenants + 1,
      sampleSize: g.sampleSize + a.sampleSize,
      positives: g.positives + a.positives,
      fit: mergeDimStats(g.fit, a.fit),
      quality: mergeDimStats(g.quality, a.quality),
      trust: mergeDimStats(g.trust, a.trust),
      conversion: mergeDimStats(g.conversion, a.conversion),
    };
  }
  return g;
}

/**
 * Derive meta-prior weights from a pooled aggregate, shrunk toward `prior`.
 * Mirrors learned-scoring.learnHireProbabilityWeights exactly, but reads from
 * sufficient stats instead of raw rows:
 *  • per-dimension positive Pearson (negative ⇒ 0; a non-predictive dimension
 *    earns no weight),
 *  • normalise positives into a weight vector summing to 1.0,
 *  • blend λ=N/(N+K)·data + (1−λ)·prior (thin global data ⇒ stay near prior),
 *  • degenerate global data (no positive correlation anywhere) ⇒ prior unchanged.
 */
export function weightsFromGlobalAggregate(
  g: GlobalAggregate,
  prior: HireWeights,
  shrinkageK: number = SHRINKAGE_K,
): { weights: HireWeights; degenerate: boolean } {
  const n = g.sampleSize;
  if (n === 0) return { weights: { ...prior }, degenerate: true };

  const corr = {
    fit:        Math.max(0, pearsonFromStats(g.fit)),
    quality:    Math.max(0, pearsonFromStats(g.quality)),
    trust:      Math.max(0, pearsonFromStats(g.trust)),
    conversion: Math.max(0, pearsonFromStats(g.conversion)),
  };
  const sum = corr.fit + corr.quality + corr.trust + corr.conversion;
  if (sum <= 0) return { weights: { ...prior }, degenerate: true };

  const data: HireWeights = {
    fit:        corr.fit / sum,
    quality:    corr.quality / sum,
    trust:      corr.trust / sum,
    conversion: corr.conversion / sum,
  };
  const lambda = n / (n + shrinkageK);
  const blend = (d: number, p: number) => lambda * d + (1 - lambda) * p;
  const weights: HireWeights = {
    fit:        round4(blend(data.fit, prior.fit)),
    quality:    round4(blend(data.quality, prior.quality)),
    trust:      round4(blend(data.trust, prior.trust)),
    conversion: round4(blend(data.conversion, prior.conversion)),
  };
  return { weights, degenerate: false };
}

/**
 * PURE serving-gate decision for the meta-prior. Given the active meta row (or
 * null), the fallback prior, and the gates, return the prior the engine should
 * use as a cold-start shrink-target. Falls back to `fallbackPrior` on every
 * unhealthy condition — no row, below the tenant or sample gate, or malformed
 * weights. Never throws.
 */
export function selectMetaPrior(args: {
  meta: { priorJson: unknown; sampleSize: number; contributingTenants: number } | null;
  fallbackPrior: HireWeights;
  minSamples: number;
  minTenants: number;
}): HireWeights {
  const { meta, fallbackPrior, minSamples, minTenants } = args;
  if (!meta) return fallbackPrior;
  if (!Number.isFinite(meta.sampleSize) || meta.sampleSize < minSamples) return fallbackPrior;
  if (!Number.isFinite(meta.contributingTenants) || meta.contributingTenants < minTenants) return fallbackPrior;
  const w = validateHireWeights(meta.priorJson);
  return w ?? fallbackPrior;
}

/** Validate an unknown value is a usable HireWeights (4 finite non-negative
 *  numbers, not all zero). Returns null on any problem (never throws). */
export function validateHireWeights(raw: unknown): HireWeights | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as any;
  const keys = ["fit", "quality", "trust", "conversion"] as const;
  let sum = 0;
  for (const k of keys) {
    const v = c[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    sum += v;
  }
  if (sum <= 0) return null;
  return { fit: c.fit, quality: c.quality, trust: c.trust, conversion: c.conversion };
}

/* ── DB-backed helpers ────────────────────────────────────────────────────── */

/** Distinct tenant ids that have at least one labeled outcome. Returns tenant
 *  identifiers ONLY (a platform-admin enumeration) — never candidate-level data.
 *  Read via controlDb because aggregation is an offline platform operation. */
export async function loadTenantIdsWithOutcomes(): Promise<string[]> {
  // Intentionally cross-tenant: enumerates tenant ids only (no candidate PII)
  // for the offline global-prior aggregation.
  classBRead(CLASS_B_READ_EXEMPTION.CROSS_TENANT_MODEL_TRAINING);
  const rows = await controlDb
    .selectDistinct({ tenantId: candidateJobIntelligenceTable.tenantId })
    .from(candidateJobIntelligenceTable)
    .where(isNotNull(candidateJobIntelligenceTable.outcome));
  return rows.map((r) => r.tenantId).filter((t): t is string => typeof t === "string" && t.length > 0);
}

/**
 * Reduce ONE tenant's labeled rows to a TenantAggregate. The candidate-level
 * rows are loaded, scored, and reduced ENTIRELY within this tenant's boundary
 * and then discarded; only the sufficient-statistic aggregate is returned. This
 * is the single choke point where candidate data is touched, and it is keyed to
 * exactly one tenant id. Returns null below the per-tenant contribution gate.
 */
export async function computeTenantAggregate(
  tenantId: string,
  base: ScoringConfig,
  minTenantSamples: number = MIN_TENANT_SAMPLES,
): Promise<TenantAggregate | null> {
  const labeled = await loadTenantLabeledRows(tenantId);
  if (labeled.length < minTenantSamples) return null;
  const scoreRows = rowsToDimensionScores(labeled, base);
  return rowsToAggregate(scoreRows);
}

/**
 * Pool aggregates across every tenant with labeled outcomes. Each tenant is
 * processed fully and independently — at no point are two tenants' candidate
 * rows co-resident. Returns the pooled aggregate plus bookkeeping counts.
 */
export async function aggregateAcrossTenants(
  base: ScoringConfig,
  minTenantSamples: number = MIN_TENANT_SAMPLES,
): Promise<{ global: GlobalAggregate; contributingTenants: number; skippedTenants: number }> {
  const tenantIds = await loadTenantIdsWithOutcomes();
  const aggs: TenantAggregate[] = [];
  let skipped = 0;
  for (const tid of tenantIds) {
    const agg = await computeTenantAggregate(tid, base, minTenantSamples);
    if (agg) aggs.push(agg);
    else skipped++;
  }
  const global = poolAggregates(aggs);
  return { global, contributingTenants: aggs.length, skippedTenants: skipped };
}

export interface FederatedEvaluation {
  tenantsEvaluated: number;
  tenantsImproved: number;
  totalSamples: number;
  /** Sample-weighted mean F1 delta (metaPrior − builtin) across tenants. */
  weightedF1Delta: number;
  /** Sample-weighted mean calibration-error delta (metaPrior − builtin). */
  weightedCalibrationDelta: number;
  /** True when the meta-prior should be promoted (net improvement). */
  improves: boolean;
}

/**
 * Federated evaluation: each tenant backtests the meta-prior config against the
 * builtin/live config on its OWN labeled rows (rows never leave the tenant
 * boundary) and only the scalar metrics are aggregated. The meta-prior is judged
 * to improve when the sample-weighted F1 delta is strictly positive (ties favour
 * the incumbent builtin). Pure-isolation: candidate data stays per-tenant.
 */
export async function evaluateMetaPriorPerTenant(
  metaConfig: ScoringConfig,
  baselineConfig: ScoringConfig,
  tenantIds: string[],
  opts: { threshold?: number; minTenantSamples?: number } = {},
): Promise<FederatedEvaluation> {
  const threshold = opts.threshold ?? EVAL_THRESHOLD;
  const minTenantSamples = opts.minTenantSamples ?? MIN_TENANT_SAMPLES;
  let tenantsEvaluated = 0;
  let tenantsImproved = 0;
  let totalSamples = 0;
  let f1WeightedSum = 0;
  let calWeightedSum = 0;
  let f1WeightDenom = 0;

  for (const tid of tenantIds) {
    const labeled = await loadTenantLabeledRows(tid);
    if (labeled.length < minTenantSamples) continue;
    const cmp = compareConfigs(metaConfig, baselineConfig, labeled, threshold);
    if (cmp.insufficientData) continue;
    tenantsEvaluated++;
    const w = labeled.length;
    totalSamples += w;
    if (typeof cmp.deltas.f1 === "number") {
      f1WeightedSum += cmp.deltas.f1 * w;
      f1WeightDenom += w;
    }
    calWeightedSum += cmp.deltas.calibrationError * w;
    if (cmp.winner === "candidate") tenantsImproved++;
  }

  const weightedF1Delta = f1WeightDenom > 0 ? round4(f1WeightedSum / f1WeightDenom) : 0;
  const weightedCalibrationDelta = totalSamples > 0 ? round4(calWeightedSum / totalSamples) : 0;
  // Improvement: positive weighted F1 delta, OR (when F1 is unavailable across
  // the board) a strict reduction in calibration error.
  const improves = f1WeightDenom > 0
    ? weightedF1Delta > 0
    : weightedCalibrationDelta < 0;

  return {
    tenantsEvaluated,
    tenantsImproved,
    totalSamples,
    weightedF1Delta,
    weightedCalibrationDelta,
    improves,
  };
}

/** The currently active meta-prior row, or null. */
export async function getActiveGlobalPrior(): Promise<
  { version: string; priorJson: unknown; sampleSize: number; contributingTenants: number; isActive: boolean } | null
> {
  const [row] = await controlDb
    .select({
      version: globalScoringPriorsTable.version,
      priorJson: globalScoringPriorsTable.priorJson,
      sampleSize: globalScoringPriorsTable.sampleSize,
      contributingTenants: globalScoringPriorsTable.contributingTenants,
      isActive: globalScoringPriorsTable.isActive,
    })
    .from(globalScoringPriorsTable)
    .where(eq(globalScoringPriorsTable.isActive, true))
    .orderBy(desc(globalScoringPriorsTable.updatedAt), desc(globalScoringPriorsTable.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The active meta-prior weights + version, or null. NEVER throws — any failure
 * (DB down, malformed row, below gate) yields null so the caller keeps the
 * static builtin/live prior. This is the read path consumed by learned-scoring.
 */
export async function getMetaPrior(): Promise<{ weights: HireWeights; version: string } | null> {
  try {
    const row = await getActiveGlobalPrior();
    if (!row) return null;
    const weights = selectMetaPrior({
      meta: row,
      fallbackPrior: BUILTIN_LIVE_CONFIG.weights.hireProbability,
      minSamples: MIN_TOTAL_SAMPLES,
      minTenants: MIN_CONTRIBUTING_TENANTS,
    });
    // selectMetaPrior returns the fallback (builtin) on any unhealthy condition;
    // treat "fell back to builtin" as "no usable meta-prior".
    if (weights === BUILTIN_LIVE_CONFIG.weights.hireProbability) return null;
    return { weights, version: row.version };
  } catch (err) {
    logger.warn({ err }, "[global-prior] meta-prior read failed — using builtin/live prior");
    return null;
  }
}

/** List all meta-prior versions, newest first. */
export async function listGlobalPriorVersions() {
  return controlDb
    .select()
    .from(globalScoringPriorsTable)
    .orderBy(desc(globalScoringPriorsTable.createdAt));
}

/** Deactivate all meta-prior versions (revert everyone to the static builtin
 *  cold-start prior). Returns the number of rows deactivated. */
export async function deactivateGlobalPriors(): Promise<number> {
  const rows = await controlDb
    .update(globalScoringPriorsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(globalScoringPriorsTable.isActive, true))
    .returning({ id: globalScoringPriorsTable.id });
  return rows.length;
}

export type GlobalPriorTrainStatus =
  | "promoted"               // meta-prior cleared all gates and was activated
  | "rejected_by_evaluation" // failed the federated improvement gate; recorded inactive
  | "degenerate"             // no usable global signal; recorded inactive (≈ builtin)
  | "insufficient_tenants"   // fewer than MIN_CONTRIBUTING_TENANTS contributed
  | "insufficient_samples";  // fewer than MIN_TOTAL_SAMPLES pooled

export interface GlobalPriorTrainResult {
  status: GlobalPriorTrainStatus;
  version: string | null;
  activated: boolean;
  contributingTenants: number;
  skippedTenants: number;
  sampleSize: number;
  gates: { minTenants: number; minTotalSamples: number; minTenantSamples: number; shrinkageK: number };
  evaluation: FederatedEvaluation | null;
}

/**
 * Offline training entry point for the platform meta-prior. Two passes, both
 * isolation-preserving:
 *   Pass 1 — aggregate sufficient stats across tenants (rows discarded per
 *            tenant) and learn shrunk meta-prior weights.
 *   Pass 2 — federated evaluation: each tenant backtests the candidate meta-prior
 *            vs builtin on its own rows; only scalar metrics aggregate.
 * The meta-prior is ACTIVATED only when it clears the contributing-tenant gate,
 * the total-sample gate, is non-degenerate, AND the federated evaluation shows a
 * net improvement. Otherwise it is recorded inactive (audit trail) and everyone
 * stays on the static builtin prior. Writes at most one new version per call.
 */
export async function trainGlobalPrior(
  opts: { threshold?: number; shrinkageK?: number; minTenantSamples?: number } = {},
): Promise<GlobalPriorTrainResult> {
  const shrinkageK = opts.shrinkageK ?? SHRINKAGE_K;
  const minTenantSamples = opts.minTenantSamples ?? MIN_TENANT_SAMPLES;
  const threshold = opts.threshold ?? EVAL_THRESHOLD;
  const gates = {
    minTenants: MIN_CONTRIBUTING_TENANTS,
    minTotalSamples: MIN_TOTAL_SAMPLES,
    minTenantSamples,
    shrinkageK,
  };

  const live = await getLiveScoringConfig();
  // The prior we shrink toward is the deterministic builtin so the meta-prior is
  // anchored to the platform baseline, not to a (possibly already learned) live.
  const builtinPrior = BUILTIN_LIVE_CONFIG.weights.hireProbability;

  const { global, contributingTenants, skippedTenants } = await aggregateAcrossTenants(live, minTenantSamples);

  const baseResult = {
    version: null as string | null,
    activated: false,
    contributingTenants,
    skippedTenants,
    sampleSize: global.sampleSize,
    gates,
    evaluation: null as FederatedEvaluation | null,
  };

  if (contributingTenants < MIN_CONTRIBUTING_TENANTS) {
    return { ...baseResult, status: "insufficient_tenants" };
  }
  if (global.sampleSize < MIN_TOTAL_SAMPLES) {
    return { ...baseResult, status: "insufficient_samples" };
  }

  const learned = weightsFromGlobalAggregate(global, builtinPrior, shrinkageK);
  // Random suffix so two concurrent training runs can't collide on the unique
  // `version` column (Date.now() alone is not collision-proof).
  const version = `global-prior-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const metaConfig: ScoringConfig = {
    ...live,
    version: `${version}/cfg`,
    label: `Global meta-prior (tenants=${contributingTenants}, n=${global.sampleSize})`,
    weights: { ...live.weights, hireProbability: { ...learned.weights } },
  };

  if (learned.degenerate) {
    await persistGlobalPrior({
      version, learned: learned.weights, sampleSize: global.sampleSize,
      contributingTenants, aggregate: global, evaluation: null, activate: false,
      notes: "Degenerate global signal — recorded inactive (≈ builtin).",
    });
    return { ...baseResult, version, status: "degenerate" };
  }

  // Pass 2: federated evaluation against the builtin baseline.
  const tenantIds = await loadTenantIdsWithOutcomes();
  const baselineConfig: ScoringConfig = {
    ...live,
    version: `${version}/baseline`,
    label: "Builtin baseline",
    weights: { ...live.weights, hireProbability: { ...builtinPrior } },
  };
  const evaluation = await evaluateMetaPriorPerTenant(metaConfig, baselineConfig, tenantIds, {
    threshold, minTenantSamples,
  });

  const promote = evaluation.improves;
  await persistGlobalPrior({
    version, learned: learned.weights, sampleSize: global.sampleSize,
    contributingTenants, aggregate: global, evaluation, activate: promote,
    notes: promote
      ? `Promoted: weighted F1 delta ${evaluation.weightedF1Delta} over ${evaluation.tenantsEvaluated} tenant(s).`
      : `Rejected by evaluation: weighted F1 delta ${evaluation.weightedF1Delta}.`,
  });

  if (promote) {
    logger.info({ version, contributingTenants, sampleSize: global.sampleSize }, "[global-prior] meta-prior promoted");
  } else {
    logger.info({ version, weightedF1Delta: evaluation.weightedF1Delta }, "[global-prior] meta-prior did not improve — recorded inactive");
  }

  return {
    ...baseResult,
    version,
    activated: promote,
    evaluation,
    status: promote ? "promoted" : "rejected_by_evaluation",
  };
}

/** Persist one meta-prior version. When `activate`, demote any active row first
 *  so exactly one stays active (deactivate-then-activate transaction). */
async function persistGlobalPrior(args: {
  version: string;
  learned: HireWeights;
  sampleSize: number;
  contributingTenants: number;
  aggregate: GlobalAggregate;
  evaluation: FederatedEvaluation | null;
  activate: boolean;
  notes: string;
}): Promise<void> {
  const { version, learned, sampleSize, contributingTenants, aggregate, evaluation, activate, notes } = args;
  const values = {
    version,
    label: `Global meta-prior (tenants=${contributingTenants}, n=${sampleSize})`,
    priorJson: learned,
    sampleSize,
    contributingTenants,
    aggregateJson: aggregate,
    evaluationJson: evaluation,
    notes,
  };
  if (activate) {
    await controlDb.transaction(async (tx) => {
      await tx
        .update(globalScoringPriorsTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(globalScoringPriorsTable.isActive, true));
      await tx.insert(globalScoringPriorsTable).values({ ...values, isActive: true });
    });
  } else {
    await controlDb.insert(globalScoringPriorsTable).values({ ...values, isActive: false });
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
