/**
 * learned-scoring.ts — Per-tenant outcome-calibrated learned scoring weights
 *
 * ─── What this closes ────────────────────────────────────────────────────────
 * The intelligence engine composes `hireProbability` from four dimension scores
 * (fit · quality · trust · conversion) using a FIXED, hardcoded set of weights
 * (BUILTIN_LIVE_CONFIG / the live registry config). This module learns those
 * four composite weights from a single tenant's OWN labeled outcomes and lets a
 * tenant's scoring drift toward what actually predicts hires for them — without
 * ever risking the deterministic baseline.
 *
 * ─── The five guarantees ─────────────────────────────────────────────────────
 *  1. Training (offline): {@link learnHireProbabilityWeights} derives weights
 *     from labeled outcomes and shrinks them toward the hardcoded prior with a
 *     strength inversely proportional to the label count (thin data ⇒ stay near
 *     the prior; lots of data ⇒ trust the data).
 *  2. Sample-gating: a learned config never activates until the tenant crosses
 *     {@link MIN_SAMPLES} (tunable via LEARNED_SCORING_MIN_SAMPLES). Below it,
 *     scoring is byte-for-byte identical to today.
 *  3. Versioned store + read path: learned configs persist in
 *     `tenant_scoring_weights`; {@link getEffectiveScoringConfig} reads the
 *     active one when present, else the live/hardcoded config.
 *  4. Backtest gate: {@link trainTenantWeights} only ACTIVATES a learned config
 *     if it beats the live config on that tenant's labeled set (via the backtest
 *     harness). A losing config is recorded inactive, never promoted.
 *  5. Fallback: {@link getEffectiveScoringConfig} NEVER throws — a missing,
 *     invalid, below-gate, or inactive learned config silently falls back to the
 *     deterministic model. See {@link selectEffectiveConfig} (pure) for the
 *     decision logic exercised by the unit tests.
 *
 * ─── Label source ────────────────────────────────────────────────────────────
 * The signals required to re-score a candidate live ONLY in
 * `candidate_job_intelligence`, which also mirrors the terminal outcome label.
 * The backtest harness (the required gate) reads that same table, so training
 * uses the same labeled set end to end.
 *
 * Storage is read/written via `controlDb` (cross-tenant, platform-admin concern)
 * with an explicit tenant_id filter — never a tenant-scoped RLS connection,
 * because training is an offline platform operation keyed by tenant id.
 */
import { controlDb, tenantScoringWeightsTable, candidateJobIntelligenceTable } from "@workspace/db";
import { eq, and, isNotNull, desc } from "drizzle-orm";
import { intelTenantScope } from "./class-b-access";
import { logger } from "./logger";
import {
  computeScores,
  type AgentSignals,
  type SignalTimestamps,
  type HiringOutcome,
} from "./intelligence";
import {
  type ScoringConfig,
  getLiveScoringConfig,
  validateScoringConfig,
  BUILTIN_LIVE_CONFIG,
} from "./scoring-config";
import {
  compareConfigs,
  type LabeledRow,
  type BacktestComparison,
} from "./backtest";
import { getMetaPrior } from "./global-prior";

/* ── Tunables ─────────────────────────────────────────────────────────────────
 * Read once at module load. The sample gate is surfaced through the admin
 * status route so operators can see (and, via env, change) the threshold. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Minimum labeled outcomes a tenant must have before learned weights activate. */
export const MIN_SAMPLES = envInt("LEARNED_SCORING_MIN_SAMPLES", 25);
/** Shrinkage constant K: blend weight on data is n/(n+K). Larger K ⇒ stays
 *  closer to the prior for longer (stronger shrinkage at a given n). */
export const SHRINKAGE_K = envInt("LEARNED_SCORING_SHRINKAGE_K", 50);
/** Decision threshold used by the backtest gate (predicted-positive cutoff). */
export const BACKTEST_THRESHOLD = envInt("LEARNED_SCORING_THRESHOLD", 50);

/* ── Types ────────────────────────────────────────────────────────────────── */

type HireWeights = ScoringConfig["weights"]["hireProbability"];

/** One row reduced to the four dimension scores + the binary hire label. */
export interface DimensionScoreRow {
  fit: number;
  quality: number;
  trust: number;
  conversion: number;
  hired: 0 | 1;
}

export interface LearnedWeightsResult {
  weights: HireWeights;
  sampleSize: number;
  /** True when the data was degenerate (no positive signal) and we returned the
   *  prior unchanged. */
  degenerate: boolean;
}

export type TrainStatus =
  | "promoted"            // learned config beat live and was activated
  | "rejected_by_backtest" // learned config did not beat live; recorded inactive
  | "insufficient_samples"; // below the sample gate; nothing learned

export interface TrainResult {
  tenantId: string;
  status: TrainStatus;
  sampleSize: number;
  minSamples: number;
  activated: boolean;
  version: string | null;
  comparison: BacktestComparison | null;
}

const POSITIVE_OUTCOMES: ReadonlySet<HiringOutcome> = new Set(["hired", "offer_accepted"]);

/* ── Pure learning core (no DB — unit tested) ─────────────────────────────── */

/** Pearson correlation; returns 0 when either series has zero variance. */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/**
 * Learn the four `hireProbability` composite weights from labeled dimension
 * scores, shrunk toward `prior`.
 *
 * Method (deterministic, dependency-free):
 *  • For each dimension, take its Pearson correlation with the binary hire
 *    label; only POSITIVE correlation earns weight (a dimension that does not
 *    predict hires for this tenant should not be up-weighted).
 *  • Normalise those positive correlations into a data-driven weight vector
 *    that sums to 1.0 (matching the prior's scale).
 *  • Shrink toward the prior: blended = λ·data + (1−λ)·prior, with
 *    λ = n / (n + SHRINKAGE_K). Small n ⇒ mostly prior; large n ⇒ mostly data.
 *  • If the data is degenerate (no positive correlation anywhere) return the
 *    prior unchanged so a learned config can never be *worse-shaped* than today.
 * Both inputs sum to 1.0, so the blend does too — keeping the composite on the
 * same 0–100 scale the engine already assumes.
 */
export function learnHireProbabilityWeights(
  rows: DimensionScoreRow[],
  prior: HireWeights,
): LearnedWeightsResult {
  const n = rows.length;
  if (n === 0) return { weights: { ...prior }, sampleSize: 0, degenerate: true };

  const hired = rows.map((r) => r.hired);
  const corr = {
    fit:        Math.max(0, pearson(rows.map((r) => r.fit), hired)),
    quality:    Math.max(0, pearson(rows.map((r) => r.quality), hired)),
    trust:      Math.max(0, pearson(rows.map((r) => r.trust), hired)),
    conversion: Math.max(0, pearson(rows.map((r) => r.conversion), hired)),
  };
  const sum = corr.fit + corr.quality + corr.trust + corr.conversion;
  if (sum <= 0) return { weights: { ...prior }, sampleSize: n, degenerate: true };

  const data: HireWeights = {
    fit:        corr.fit / sum,
    quality:    corr.quality / sum,
    trust:      corr.trust / sum,
    conversion: corr.conversion / sum,
  };

  const lambda = n / (n + SHRINKAGE_K);
  const blend = (d: number, p: number) => lambda * d + (1 - lambda) * p;
  const weights: HireWeights = {
    fit:        round4(blend(data.fit, prior.fit)),
    quality:    round4(blend(data.quality, prior.quality)),
    trust:      round4(blend(data.trust, prior.trust)),
    conversion: round4(blend(data.conversion, prior.conversion)),
  };
  return { weights, sampleSize: n, degenerate: false };
}

/** Build a full, valid ScoringConfig by cloning `base` and substituting only the
 *  learned hireProbability weights. */
export function buildLearnedConfig(
  tenantId: string,
  base: ScoringConfig,
  learned: HireWeights,
  sampleSize: number,
  version?: string,
): ScoringConfig {
  return {
    version: version ?? `learned-${tenantId}-${Date.now()}`,
    label: `Learned (tenant ${tenantId}, n=${sampleSize})`,
    weights: {
      ...base.weights,
      hireProbability: { ...learned },
    },
  };
}

/**
 * PURE fallback/gating decision. Given the active learned row (or null), the
 * live config, and the sample gate, return the config the engine should use.
 * Falls back to `liveConfig` on every unhealthy condition: no row, inactive,
 * below the gate, or an invalid/unparseable stored config. Never throws.
 */
export function selectEffectiveConfig(args: {
  learned: { configJson: unknown; sampleSize: number; isActive: boolean } | null;
  liveConfig: ScoringConfig;
  minSamples: number;
}): ScoringConfig {
  const { learned, liveConfig, minSamples } = args;
  if (!learned) return liveConfig;
  if (!learned.isActive) return liveConfig;
  if (!Number.isFinite(learned.sampleSize) || learned.sampleSize < minSamples) return liveConfig;
  try {
    return validateScoringConfig(learned.configJson);
  } catch {
    return liveConfig;
  }
}

/**
 * PURE cold-start substitution. Clones `live` and replaces ONLY the
 * hireProbability composite weights with the cross-tenant meta-prior, stamping a
 * traceable version so persisted intelligence rows record they used the global
 * prior. A null meta-prior returns `live` unchanged (same reference) — the
 * permanent builtin/live fallback, byte-identical to pre-network-effect behavior.
 */
export function applyMetaPrior(
  live: ScoringConfig,
  meta: { weights: HireWeights; version: string } | null,
): ScoringConfig {
  if (!meta) return live;
  return {
    ...live,
    version: `${live.version}+gp:${meta.version}`,
    label: `${live.label} (global meta-prior ${meta.version})`,
    weights: { ...live.weights, hireProbability: { ...meta.weights } },
  };
}

/* ── DB-backed helpers ────────────────────────────────────────────────────── */

/** Load a tenant's labeled rows (non-null outcome + signals). Explicit tenant
 *  filter via controlDb (offline platform operation, not RLS-scoped). */
export async function loadTenantLabeledRows(tenantId: string): Promise<LabeledRow[]> {
  const rows = await controlDb
    .select({
      signalsJson: candidateJobIntelligenceTable.signalsJson,
      signalTimestampsJson: candidateJobIntelligenceTable.signalTimestampsJson,
      outcome: candidateJobIntelligenceTable.outcome,
    })
    .from(candidateJobIntelligenceTable)
    .where(
      and(
        // Per-tenant labeled-row load, scoped via the canonical Class-B accessor.
        intelTenantScope([tenantId]),
        isNotNull(candidateJobIntelligenceTable.outcome),
      ),
    );

  const labeled: LabeledRow[] = [];
  for (const r of rows) {
    if (!r.outcome || !r.signalsJson) continue;
    labeled.push({
      signals: r.signalsJson as AgentSignals,
      timestamps: (r.signalTimestampsJson as SignalTimestamps) ?? {},
      outcome: r.outcome as HiringOutcome,
    });
  }
  return labeled;
}

/** Reduce labeled rows to dimension scores + binary label under `base`. The
 *  four dimension scores are independent of the hireProbability weights, so
 *  computing them under the base config is correct for learning the composite. */
export function rowsToDimensionScores(rows: LabeledRow[], base: ScoringConfig): DimensionScoreRow[] {
  return rows.map((r) => {
    const s = computeScores(r.signals, r.timestamps, undefined, base);
    return {
      fit: s.fitScore,
      quality: s.qualityScore,
      trust: s.trustScore,
      conversion: s.conversionScore,
      hired: POSITIVE_OUTCOMES.has(r.outcome) ? 1 : 0,
    };
  });
}

/** The currently active learned row for a tenant, or null. */
export async function getActiveLearnedRow(
  tenantId: string,
): Promise<{ version: string; configJson: unknown; sampleSize: number; isActive: boolean } | null> {
  const [row] = await controlDb
    .select({
      version: tenantScoringWeightsTable.version,
      configJson: tenantScoringWeightsTable.configJson,
      sampleSize: tenantScoringWeightsTable.sampleSize,
      isActive: tenantScoringWeightsTable.isActive,
    })
    .from(tenantScoringWeightsTable)
    .where(
      and(
        eq(tenantScoringWeightsTable.tenantId, tenantId),
        eq(tenantScoringWeightsTable.isActive, true),
      ),
    )
    // The partial unique index guarantees at most one active row per tenant;
    // the explicit ordering is a defensive tiebreak so the read is deterministic
    // even if that invariant were ever violated (newest active wins).
    .orderBy(desc(tenantScoringWeightsTable.updatedAt), desc(tenantScoringWeightsTable.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The scoring config the engine should use for a tenant RIGHT NOW. Returns the
 * tenant's active learned config when present, valid, and above the sample gate;
 * otherwise the live/hardcoded config. NEVER throws — any failure (DB down,
 * corrupt row, etc.) silently falls back to the deterministic model. This is
 * the read path consumed by upsertIntelligence / computeIntelligence.
 */
export async function getEffectiveScoringConfig(tenantId: string): Promise<ScoringConfig> {
  let live: ScoringConfig = BUILTIN_LIVE_CONFIG;
  try {
    live = await getLiveScoringConfig();
  } catch {
    /* getLiveScoringConfig already self-heals to the builtin; keep builtin. */
  }
  try {
    const learned = await getActiveLearnedRow(tenantId);
    const effective = selectEffectiveConfig({ learned, liveConfig: live, minSamples: MIN_SAMPLES });
    // The tenant has its own active learned config — it overrides any global prior.
    if (effective !== live) return effective;
    // Cold start / thin data: initialize the prior from the cross-tenant
    // meta-model when one is active. getMetaPrior never throws (null on any
    // unhealthy condition), and applyMetaPrior(live, null) === live, so this is a
    // permanent safe fallback to the static builtin/live prior.
    const meta = await getMetaPrior();
    return applyMetaPrior(live, meta);
  } catch (err) {
    logger.warn({ err, tenantId }, "[learned-scoring] effective-config read failed — using live/builtin");
    return live;
  }
}

/** List a tenant's learned versions, newest first. */
export async function listLearnedVersions(tenantId: string) {
  return controlDb
    .select()
    .from(tenantScoringWeightsTable)
    .where(eq(tenantScoringWeightsTable.tenantId, tenantId))
    .orderBy(desc(tenantScoringWeightsTable.createdAt));
}

/** Deactivate all learned versions for a tenant (revert to live/hardcoded).
 *  Returns the number of rows deactivated. */
export async function deactivateLearnedVersions(tenantId: string): Promise<number> {
  const rows = await controlDb
    .update(tenantScoringWeightsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(tenantScoringWeightsTable.tenantId, tenantId),
        eq(tenantScoringWeightsTable.isActive, true),
      ),
    )
    .returning({ id: tenantScoringWeightsTable.id });
  return rows.length;
}

/** Persist a learned version. When `activate` is true, demote any currently
 *  active version for the tenant first so exactly one stays active. */
async function persistLearnedVersion(
  tenantId: string,
  config: ScoringConfig,
  sampleSize: number,
  comparison: BacktestComparison,
  activate: boolean,
): Promise<void> {
  if (activate) {
    await controlDb.transaction(async (tx) => {
      await tx
        .update(tenantScoringWeightsTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(tenantScoringWeightsTable.tenantId, tenantId),
            eq(tenantScoringWeightsTable.isActive, true),
          ),
        );
      await tx.insert(tenantScoringWeightsTable).values({
        tenantId,
        version: config.version,
        configJson: config,
        sampleSize,
        isActive: true,
        backtestJson: comparison,
        notes: comparison.verdict,
      });
    });
  } else {
    await controlDb.insert(tenantScoringWeightsTable).values({
      tenantId,
      version: config.version,
      configJson: config,
      sampleSize,
      isActive: false,
      backtestJson: comparison,
      notes: comparison.verdict,
    });
  }
}

/**
 * Offline training entry point for one tenant. Loads the tenant's labeled set,
 * enforces the sample gate, learns shrunk weights, and runs the backtest gate
 * against the live config. A learned config is ACTIVATED only when it beats live
 * on the tenant's own outcomes; otherwise it is recorded inactive. Idempotent
 * and side-effect-bounded: writes at most one new version row per call.
 */
export async function trainTenantWeights(
  tenantId: string,
  opts: { threshold?: number } = {},
): Promise<TrainResult> {
  const threshold = opts.threshold ?? BACKTEST_THRESHOLD;
  const live = await getLiveScoringConfig();
  const labeled = await loadTenantLabeledRows(tenantId);
  const sampleSize = labeled.length;

  if (sampleSize < MIN_SAMPLES) {
    return {
      tenantId,
      status: "insufficient_samples",
      sampleSize,
      minSamples: MIN_SAMPLES,
      activated: false,
      version: null,
      comparison: null,
    };
  }

  // Shrink toward the cross-tenant meta-prior when one is active, so a thin
  // tenant's learned weights start from the network prior (not the static
  // builtin) and drift toward its own data as labels accrue. Null meta-prior ⇒
  // shrink toward live, byte-identical to pre-network-effect behavior.
  const metaPrior = await getMetaPrior();
  const prior = metaPrior?.weights ?? live.weights.hireProbability;
  const scoreRows = rowsToDimensionScores(labeled, live);
  const learned = learnHireProbabilityWeights(scoreRows, prior);
  const candidate = buildLearnedConfig(tenantId, live, learned.weights, sampleSize);
  // Gate the per-tenant config against what the tenant would otherwise serve:
  // the meta-prior cold-start config (== live when no meta-prior is active).
  const baseline = applyMetaPrior(live, metaPrior);
  const comparison = compareConfigs(candidate, baseline, labeled, threshold);

  const promote = comparison.winner === "candidate";
  await persistLearnedVersion(tenantId, candidate, sampleSize, comparison, promote);
  if (promote) {
    logger.info({ tenantId, version: candidate.version, sampleSize }, "[learned-scoring] learned config promoted");
  } else {
    logger.info({ tenantId, version: candidate.version, winner: comparison.winner }, "[learned-scoring] learned config did not beat live — recorded inactive");
  }

  return {
    tenantId,
    status: promote ? "promoted" : "rejected_by_backtest",
    sampleSize,
    minSamples: MIN_SAMPLES,
    activated: promote,
    version: candidate.version,
    comparison,
  };
}

/* ── helpers ──────────────────────────────────────────────────────────────── */
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
