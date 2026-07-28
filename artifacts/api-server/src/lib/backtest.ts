/**
 * backtest.ts — Offline replay & evaluation of scoring configs
 *
 * Re-scores historical candidate×job rows that already carry a known hiring
 * outcome under a CANDIDATE scoring config and the current LIVE config, then
 * reports precision / recall / F1 and calibration so a weight change can be
 * judged against real outcomes BEFORE it is made live.
 *
 * This is a pure offline harness: it reads `candidate_job_intelligence` (via
 * the request-scoped, RLS-aware `db`, so it only ever sees the caller's tenant
 * subtree) and re-runs `computeScores` on the stored `signalsJson`. It writes
 * nothing and changes no live behaviour.
 *
 * Labels:
 *   positive (a hire) = outcome ∈ { hired, offer_accepted }
 *   negative          = outcome ∈ { rejected, ghosted, no_show, offer_declined }
 *
 * A prediction is "positive" when re-scored hireProbability >= threshold
 * (default 50). The same threshold is applied to both configs so the only
 * variable in the comparison is the weight set.
 */
import { db, candidateJobIntelligenceTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";
import {
  computeScores,
  type AgentSignals,
  type SignalTimestamps,
  type HiringOutcome,
} from "./intelligence";
import { type ScoringConfig, getLiveScoringConfig } from "./scoring-config";

const POSITIVE_OUTCOMES: ReadonlySet<HiringOutcome> = new Set(["hired", "offer_accepted"]);

export interface CalibrationBucket {
  /** Lower bound of the predicted-probability bucket, e.g. 0, 10, 20 … */
  rangeStart: number;
  rangeEnd: number;
  count: number;
  meanPredicted: number | null;
  actualHireRate: number | null;
}

export interface BacktestMetrics {
  version: string;
  label: string;
  sampleSize: number;
  positives: number;
  negatives: number;
  threshold: number;
  /** Confusion matrix at the threshold */
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  /** Mean predicted hire probability across the sample */
  meanPredicted: number;
  /** Actual positive (hire) rate across the sample, 0–100 */
  actualHireRate: number;
  /** Expected Calibration Error (0–100; lower is better) */
  calibrationError: number;
  /** Brier score (0–1; lower is better) */
  brierScore: number;
  calibration: CalibrationBucket[];
}

export interface BacktestComparison {
  sampleSize: number;
  threshold: number;
  /** True when there were no labeled rows to score against. */
  insufficientData: boolean;
  live: BacktestMetrics;
  candidate: BacktestMetrics;
  /** "candidate" | "live" | "tie" — primary key is F1, tie-break by lower ECE. */
  winner: "candidate" | "live" | "tie";
  /** Human-readable verdict, e.g. "candidate v4 beats live v3 on 142 outcomes". */
  verdict: string;
  /** Signed deltas (candidate − live) on the headline metrics. */
  deltas: { f1: number | null; precision: number | null; recall: number | null; calibrationError: number };
}

export interface LabeledRow {
  signals: AgentSignals;
  timestamps: SignalTimestamps;
  outcome: HiringOutcome;
}

/** Load all labeled rows (non-null outcome + signals) across ALL tenants.
 *  candidate_job_intelligence is Class-B (no RLS), so despite the `db` proxy
 *  this is genuinely cross-tenant — see the classBRead note below. */
export async function loadLabeledRows(): Promise<LabeledRow[]> {
  // Intentionally cross-tenant: pools all labeled outcomes into a federated
  // promotion/eval backtest; reduces to aggregate accuracy, never returns
  // per-candidate PII. Reachable via POST /learning/backtest (STAFF_ROLES),
  // whose response is the aggregate comparison only.
  classBRead(CLASS_B_READ_EXEMPTION.CROSS_TENANT_MODEL_TRAINING);
  const rows = await db
    .select({
      signalsJson: candidateJobIntelligenceTable.signalsJson,
      signalTimestampsJson: candidateJobIntelligenceTable.signalTimestampsJson,
      outcome: candidateJobIntelligenceTable.outcome,
    })
    .from(candidateJobIntelligenceTable)
    .where(isNotNull(candidateJobIntelligenceTable.outcome));

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

/** Score one config over a pre-loaded labeled set. */
export function scoreConfig(
  config: ScoringConfig,
  rows: LabeledRow[],
  threshold: number,
): BacktestMetrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let positives = 0;
  let predictedSum = 0;
  let brierSum = 0;

  // 10 calibration buckets of width 10 (0–10, 10–20, …, 90–100)
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    rangeStart: i * 10,
    rangeEnd: (i + 1) * 10,
    count: 0,
    predictedSum: 0,
    positiveCount: 0,
  }));

  for (const row of rows) {
    const { hireProbability } = computeScores(row.signals, row.timestamps, undefined, config);
    const actualPositive = POSITIVE_OUTCOMES.has(row.outcome);
    const predictedPositive = hireProbability >= threshold;

    if (actualPositive) positives++;
    if (predictedPositive && actualPositive) tp++;
    else if (predictedPositive && !actualPositive) fp++;
    else if (!predictedPositive && !actualPositive) tn++;
    else fn++;

    predictedSum += hireProbability;
    const p = hireProbability / 100;
    const y = actualPositive ? 1 : 0;
    brierSum += (p - y) * (p - y);

    const bi = Math.min(9, Math.max(0, Math.floor(hireProbability / 10)));
    buckets[bi].count++;
    buckets[bi].predictedSum += hireProbability;
    if (actualPositive) buckets[bi].positiveCount++;
  }

  const n = rows.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  const accuracy = n > 0 ? (tp + tn) / n : null;
  const meanPredicted = n > 0 ? predictedSum / n : 0;
  const actualHireRate = n > 0 ? (positives / n) * 100 : 0;

  // Expected Calibration Error: weighted mean abs gap between predicted and
  // observed hire rate across populated buckets.
  let ece = 0;
  const calibration: CalibrationBucket[] = buckets.map((b) => {
    const meanP = b.count > 0 ? b.predictedSum / b.count : null;
    const actual = b.count > 0 ? (b.positiveCount / b.count) * 100 : null;
    if (b.count > 0 && meanP !== null && actual !== null) {
      ece += (b.count / n) * Math.abs(meanP - actual);
    }
    return {
      rangeStart: b.rangeStart,
      rangeEnd: b.rangeEnd,
      count: b.count,
      meanPredicted: meanP !== null ? round1(meanP) : null,
      actualHireRate: actual !== null ? round1(actual) : null,
    };
  });

  return {
    version: config.version,
    label: config.label,
    sampleSize: n,
    positives,
    negatives: n - positives,
    threshold,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: precision !== null ? round3(precision) : null,
    recall: recall !== null ? round3(recall) : null,
    f1: f1 !== null ? round3(f1) : null,
    accuracy: accuracy !== null ? round3(accuracy) : null,
    meanPredicted: round1(meanPredicted),
    actualHireRate: round1(actualHireRate),
    calibrationError: round1(ece),
    brierScore: n > 0 ? round3(brierSum / n) : 0,
    calibration,
  };
}

/**
 * Compare a candidate config against a live config over a PRE-LOADED labeled
 * set. Pure (no DB) so callers that already hold a tenant-scoped row set — e.g.
 * the learned-scoring trainer — can reuse the exact same winner logic as the
 * live backtest endpoint. Winner: higher F1 wins; if F1 is tied or unavailable,
 * lower calibration error wins; never a winner on an empty sample.
 */
export function compareConfigs(
  candidateConfig: ScoringConfig,
  liveConfig: ScoringConfig,
  rows: LabeledRow[],
  threshold = 50,
): BacktestComparison {
  const t = clampThreshold(threshold);
  const live = scoreConfig(liveConfig, rows, t);
  const candidate = scoreConfig(candidateConfig, rows, t);

  const insufficientData = rows.length === 0;

  let winner: "candidate" | "live" | "tie" = "tie";
  if (!insufficientData) {
    const cF1 = candidate.f1, lF1 = live.f1;
    if (cF1 !== null && lF1 !== null && cF1 !== lF1) {
      winner = cF1 > lF1 ? "candidate" : "live";
    } else if (candidate.calibrationError !== live.calibrationError) {
      winner = candidate.calibrationError < live.calibrationError ? "candidate" : "live";
    }
  }

  const verdict = insufficientData
    ? "No labeled outcomes available — cannot evaluate this scoring config yet."
    : winner === "tie"
      ? `candidate ${candidate.version} and live ${live.version} are tied on ${rows.length} outcome(s).`
      : `${winner === "candidate" ? `candidate ${candidate.version}` : `live ${live.version}`} beats ${winner === "candidate" ? `live ${live.version}` : `candidate ${candidate.version}`} on ${rows.length} outcome(s).`;

  return {
    sampleSize: rows.length,
    threshold: t,
    insufficientData,
    live,
    candidate,
    winner,
    verdict,
    deltas: {
      f1: candidate.f1 !== null && live.f1 !== null ? round3(candidate.f1 - live.f1) : null,
      precision: candidate.precision !== null && live.precision !== null ? round3(candidate.precision - live.precision) : null,
      recall: candidate.recall !== null && live.recall !== null ? round3(candidate.recall - live.recall) : null,
      calibrationError: round1(candidate.calibrationError - live.calibrationError),
    },
  };
}

/**
 * Replay the labeled set (caller's RLS scope) under both the candidate config
 * and the current live config and return a side-by-side comparison.
 */
export async function runBacktest(
  candidateConfig: ScoringConfig,
  opts: { threshold?: number } = {},
): Promise<BacktestComparison> {
  const threshold = clampThreshold(opts.threshold ?? 50);
  const liveConfig = await getLiveScoringConfig();
  const rows = await loadLabeledRows();
  return compareConfigs(candidateConfig, liveConfig, rows, threshold);
}

/* ── helpers ──────────────────────────────────────────────────────────────── */
function round1(n: number): number { return Math.round(n * 10) / 10; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, n));
}
