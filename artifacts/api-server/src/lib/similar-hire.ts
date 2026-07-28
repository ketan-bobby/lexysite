/**
 * similar-hire.ts — Real similar-hire embedding signal (Task #26)
 *
 * ─── What this closes ────────────────────────────────────────────────────────
 * `similarHirePatternScore` is the ICP-pattern slice of the intelligence
 * engine's fitScore (consumed at intelligence.ts via
 * `analytics.similarHirePatternScore`). It was a placeholder — never produced —
 * so the ICP slice of fitScore silently went unused. This module turns it into a
 * REAL signal: the cosine similarity (kNN, mean of the top-K) of a candidate's
 * profile embedding against the embeddings of a tenant's ACTUAL successful hires
 * (outcome ∈ {hired, offer_accepted}) in the SAME role family.
 *
 * ─── The guarantees (mirrors lib/learned-scoring.ts) ──────────────────────────
 *  1. Corpus-first: candidate profiles are embedded and stored from now on
 *     ({@link ensureCandidateEmbedding}), so the comparison corpus accumulates
 *     BEFORE the signal ever turns on.
 *  2. Per-role exemplar gate: the embedding path is used only when a role family
 *     has at least {@link MIN_HIRE_EXEMPLARS} successful-hire exemplars with
 *     stored embeddings. Below it, the signal falls back.
 *  3. Per-tenant activation gate: the embedding signal only "ships" (feeds the
 *     live fitScore) for a tenant after {@link trainSimilarHireSignal} confirms,
 *     via the backtest harness, that it beats the fallback baseline on that
 *     tenant's labeled outcomes. A losing/insufficient run is recorded inactive.
 *  4. Permanent fallback: when not activated, below the exemplar gate, or on ANY
 *     failure, the score falls back to today's LLM-vs-ICP comparison
 *     ({@link scoreCandidateForJob}). Nothing here ever throws on the hot path.
 *  5. Backtest-gated: {@link backtestSimilarHireSignal} re-scores the tenant's
 *     labeled set WITH vs WITHOUT the augmented signal under the live config and
 *     reuses the exact winner logic (higher F1, tie-break lower ECE) from the
 *     backtest harness.
 *
 * Role family is keyed strictly on `ideal_candidate_profiles.role_family`, so the
 * target job and the corpus jobs are grouped by the same key. A job with no role
 * family simply routes to the fallback (safe) — never a fuzzy title match that
 * could silently mis-group exemplars.
 *
 * Storage is read/written via `controlDb` (cross-tenant, platform/offline
 * concern) with an explicit tenant_id filter — the same pattern learned-scoring
 * uses, since training is an offline operation keyed by tenant id and the screening
 * producer runs in a background agent context.
 */
import crypto from "node:crypto";
import {
  controlDb,
  candidateEmbeddingsTable,
  similarHireModelsTable,
  candidatesTable,
  candidateJobIntelligenceTable,
  icpTable,
  jobsTable,
} from "@workspace/db";
import { eq, and, ne, isNotNull, inArray, desc } from "drizzle-orm";
import { intelTenantScope } from "./class-b-access";
import { logger } from "./logger";
import { generateEmbedding, EMBEDDING_MODEL, EMBEDDING_DIMS } from "./ai";
import { scoreCandidateForJob } from "./icp-generator";
import {
  scoreConfig,
  type LabeledRow,
  type BacktestComparison,
  type BacktestMetrics,
} from "./backtest";
import { getLiveScoringConfig, type ScoringConfig } from "./scoring-config";
import type { AgentSignals, SignalTimestamps, HiringOutcome } from "./intelligence";

/* ── Tunables ─────────────────────────────────────────────────────────────────
 * Read once at module load. Surfaced through the admin status route. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Min successful-hire exemplars (with stored embeddings) a role family needs
 *  before the embedding path is used; below it the signal falls back. */
export const MIN_HIRE_EXEMPLARS = envInt("SIMILAR_HIRE_MIN_EXEMPLARS", 5);
/** How many nearest exemplars to average for the kNN score. */
export const TOP_K = envInt("SIMILAR_HIRE_TOP_K", 5);
/** Decision threshold used by the backtest gate (predicted-positive cutoff). */
export const BACKTEST_THRESHOLD = envInt("SIMILAR_HIRE_THRESHOLD", 50);

const POSITIVE_OUTCOMES: HiringOutcome[] = ["hired", "offer_accepted"];

/* ── Pure cores (unit-tested; no DB, no I/O) ──────────────────────────────── */

/**
 * Deterministic profile text for embedding. Skills are de-duplicated and sorted
 * so the same underlying profile always hashes to the same value (the writer can
 * skip re-embedding unchanged profiles) regardless of skill ordering.
 */
export function buildCandidateProfileText(c: {
  currentTitle?: string | null;
  currentCompany?: string | null;
  skills?: string[] | null;
}): string {
  const title = (c.currentTitle ?? "").trim();
  const company = (c.currentCompany ?? "").trim();
  const skills = Array.from(
    new Set((Array.isArray(c.skills) ? c.skills : []).map((s) => (s ?? "").trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
  const lines = [
    `Title: ${title || "Unknown"}`,
    `Company: ${company || "Unknown"}`,
    `Skills: ${skills.join(", ")}`,
  ];
  return lines.join("\n").trim();
}

/** Stable hash of the (model, text) pair — identifies a stored vector's source. */
export function profileTextHash(model: string, text: string): string {
  return crypto.createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

/** Cosine similarity in [-1, 1]; 0 for zero-norm or mismatched-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Map a set of cosine similarities to a 0–100 score: take the top-K (most
 * similar) exemplars, average them, and rescale [-1, 1] → [0, 100]. Returns null
 * when there is nothing to score. Deterministic.
 */
export function scoreFromSimilarities(sims: number[], topK: number = TOP_K): number | null {
  const finite = sims.filter((s) => Number.isFinite(s));
  if (finite.length === 0) return null;
  const k = Math.max(1, Math.min(topK, finite.length));
  const top = [...finite].sort((a, b) => b - a).slice(0, k);
  const mean = top.reduce((s, v) => s + v, 0) / top.length;
  const scaled = ((mean + 1) / 2) * 100;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/**
 * PURE strategy decision. The embedding path is used ONLY when the tenant has
 * activated the signal AND the role family has enough exemplars; otherwise the
 * fallback (LLM-vs-ICP) is used. Never throws.
 */
export function selectSimilarHireStrategy(args: {
  active: boolean;
  exemplarCount: number;
  minExemplars: number;
}): "embedding" | "fallback" {
  const { active, exemplarCount, minExemplars } = args;
  if (!active) return "fallback";
  if (!Number.isFinite(exemplarCount) || exemplarCount < minExemplars) return "fallback";
  return "embedding";
}

/* ── DB-backed helpers (best-effort; never throw on the hot path) ──────────── */

/**
 * Embed and store a candidate's profile vector (idempotent). Skips re-embedding
 * when the profile text is unchanged for the current model. Returns the stored
 * vector, or null when the candidate is missing / embedding is unavailable.
 * Best-effort: any failure logs and returns the existing vector (or null) — it
 * never throws, so callers can build the corpus without risk.
 */
export async function ensureCandidateEmbedding(
  tenantId: string,
  candidateId: string,
): Promise<number[] | null> {
  try {
    const [cand] = await controlDb
      .select({
        currentTitle: candidatesTable.currentTitle,
        currentCompany: candidatesTable.currentCompany,
        skills: candidatesTable.skills,
      })
      .from(candidatesTable)
      .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, tenantId)))
      .limit(1);
    if (!cand) return null;

    const profileText = buildCandidateProfileText(cand);
    if (!profileText) return null;
    const hash = profileTextHash(EMBEDDING_MODEL, profileText);

    const [existing] = await controlDb
      .select({
        vector: candidateEmbeddingsTable.vector,
        textHash: candidateEmbeddingsTable.textHash,
        model: candidateEmbeddingsTable.model,
      })
      .from(candidateEmbeddingsTable)
      .where(
        and(
          eq(candidateEmbeddingsTable.tenantId, tenantId),
          eq(candidateEmbeddingsTable.candidateId, candidateId),
        ),
      )
      .limit(1);

    if (existing && existing.model === EMBEDDING_MODEL && existing.textHash === hash) {
      return existing.vector as number[];
    }

    const vector = await generateEmbedding(profileText);
    if (!vector) {
      // Embedding unavailable — keep any prior vector rather than wiping it.
      return (existing?.vector as number[]) ?? null;
    }

    await controlDb
      .insert(candidateEmbeddingsTable)
      .values({
        tenantId,
        candidateId,
        model: EMBEDDING_MODEL,
        dims: vector.length || EMBEDDING_DIMS,
        textHash: hash,
        vector,
        profileText,
      })
      .onConflictDoUpdate({
        target: [candidateEmbeddingsTable.tenantId, candidateEmbeddingsTable.candidateId],
        set: {
          model: EMBEDDING_MODEL,
          dims: vector.length || EMBEDDING_DIMS,
          textHash: hash,
          vector,
          profileText,
          updatedAt: new Date(),
        },
      });
    return vector;
  } catch (err: any) {
    logger.warn({ err: err?.message, tenantId, candidateId }, "[similar-hire] ensureCandidateEmbedding failed");
    return null;
  }
}

/** Load a candidate's stored vector (model-matched), or null. Never throws. */
async function loadCandidateVector(tenantId: string, candidateId: string): Promise<number[] | null> {
  try {
    const [row] = await controlDb
      .select({ vector: candidateEmbeddingsTable.vector, model: candidateEmbeddingsTable.model })
      .from(candidateEmbeddingsTable)
      .where(
        and(
          eq(candidateEmbeddingsTable.tenantId, tenantId),
          eq(candidateEmbeddingsTable.candidateId, candidateId),
        ),
      )
      .limit(1);
    if (!row || row.model !== EMBEDDING_MODEL) return null;
    return row.vector as number[];
  } catch {
    return null;
  }
}

/**
 * The role-family key for a job: `ideal_candidate_profiles.role_family` (newest
 * ICP version), or null when the job has no role family. Null routes the signal
 * to the fallback — we never fuzzy-match on raw title, which would silently
 * mis-group exemplars. Never throws.
 */
export async function getRoleFamilyForJob(jobId: string, tenantId: string): Promise<string | null> {
  try {
    const [icp] = await controlDb
      .select({ roleFamily: icpTable.roleFamily })
      .from(icpTable)
      .where(and(eq(icpTable.jobId, jobId), eq(icpTable.tenantId, tenantId)))
      .orderBy(desc(icpTable.version))
      .limit(1);
    const rf = icp?.roleFamily?.trim();
    return rf ? rf : null;
  } catch {
    return null;
  }
}

/**
 * Load the stored embedding vectors of a tenant's SUCCESSFUL hires (outcome ∈
 * {hired, offer_accepted}) whose job is in the given role family. De-duplicated
 * per candidate (a person hired for several roles in the family contributes one
 * vector). `excludeCandidateId` drops the candidate being scored so a hire can
 * never match itself (honest backtest). Never throws.
 */
export async function loadSuccessfulHireVectors(
  tenantId: string,
  roleFamily: string,
  excludeCandidateId?: string,
): Promise<number[][]> {
  try {
    const conds = [
      inArray(candidateJobIntelligenceTable.outcome, POSITIVE_OUTCOMES),
      eq(icpTable.roleFamily, roleFamily),
      eq(candidateEmbeddingsTable.model, EMBEDDING_MODEL),
    ];
    if (excludeCandidateId) {
      conds.push(ne(candidateEmbeddingsTable.candidateId, excludeCandidateId));
    }
    const rows = await controlDb
      .select({
        candidateId: candidateEmbeddingsTable.candidateId,
        vector: candidateEmbeddingsTable.vector,
      })
      .from(candidateJobIntelligenceTable)
      .innerJoin(
        icpTable,
        and(
          eq(icpTable.jobId, candidateJobIntelligenceTable.jobId),
          eq(icpTable.tenantId, candidateJobIntelligenceTable.tenantId),
        ),
      )
      .innerJoin(
        candidateEmbeddingsTable,
        and(
          eq(candidateEmbeddingsTable.candidateId, candidateJobIntelligenceTable.candidateId),
          eq(candidateEmbeddingsTable.tenantId, candidateJobIntelligenceTable.tenantId),
        ),
      )
      // Per-tenant load, scoped via the canonical Class-B accessor so the guard
      // and the query agree this is single-tenant (not cross-tenant training).
      .where(and(intelTenantScope([tenantId]), ...conds));

    const seen = new Set<string>();
    const vectors: number[][] = [];
    for (const r of rows) {
      if (seen.has(r.candidateId)) continue;
      seen.add(r.candidateId);
      const v = r.vector as number[];
      if (Array.isArray(v) && v.length > 0) vectors.push(v);
    }
    return vectors;
  } catch (err: any) {
    logger.warn({ err: err?.message, tenantId, roleFamily }, "[similar-hire] loadSuccessfulHireVectors failed");
    return [];
  }
}

/** The per-tenant activation row, or null. Never throws (→ treated as inactive). */
export async function getActiveSimilarHireModel(
  tenantId: string,
): Promise<{ isActive: boolean; minExemplars: number; sampleSize: number } | null> {
  try {
    const [row] = await controlDb
      .select({
        isActive: similarHireModelsTable.isActive,
        minExemplars: similarHireModelsTable.minExemplars,
        sampleSize: similarHireModelsTable.sampleSize,
      })
      .from(similarHireModelsTable)
      .where(eq(similarHireModelsTable.tenantId, tenantId))
      .limit(1);
    return row ?? null;
  } catch (err: any) {
    logger.warn({ err: err?.message, tenantId }, "[similar-hire] activation read failed — treating as inactive");
    return null;
  }
}

/** Whether the embedding signal has been activated (backtest-confirmed) for a
 *  tenant. Never throws → false on any failure. */
export async function isSimilarHireActive(tenantId: string): Promise<boolean> {
  const row = await getActiveSimilarHireModel(tenantId);
  return !!row?.isActive;
}

export interface SimilarHireScore {
  score: number;
  source: "embedding" | "fallback";
  exemplarCount: number;
}

/**
 * Compute the similarHirePatternScore for a candidate × job. ALWAYS ensures the
 * candidate's profile is embedded + stored first (corpus building), then:
 *   • embedding path — when the tenant has activated the signal AND the job's
 *     role family has ≥ the exemplar gate of successful hires with embeddings:
 *     kNN cosine similarity (mean top-K) against those real hires.
 *   • fallback path — otherwise: today's LLM-vs-ICP comparison.
 * Returns null only when BOTH the embedding path and the fallback are
 * unavailable. Never throws — safe to call inline from an agent.
 */
export async function computeSimilarHirePatternScore(args: {
  tenantId: string;
  jobId: string;
  candidate: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    currentTitle?: string | null;
    currentCompany?: string | null;
    skills?: string[] | null;
    location?: string | null;
  };
}): Promise<SimilarHireScore | null> {
  const { tenantId, jobId, candidate } = args;

  // 1. Corpus building — store this candidate's vector regardless of the gate.
  const vector = await ensureCandidateEmbedding(tenantId, candidate.id);

  // 2. Decide the strategy.
  const model = await getActiveSimilarHireModel(tenantId);
  const active = !!model?.isActive;
  const minExemplars = model?.minExemplars ?? MIN_HIRE_EXEMPLARS;

  let exemplars: number[][] = [];
  if (active && vector) {
    const roleFamily = await getRoleFamilyForJob(jobId, tenantId);
    if (roleFamily) {
      exemplars = await loadSuccessfulHireVectors(tenantId, roleFamily, candidate.id);
    }
  }

  const strategy = selectSimilarHireStrategy({ active, exemplarCount: exemplars.length, minExemplars });

  if (strategy === "embedding" && vector) {
    const sims = exemplars.map((e) => cosineSimilarity(vector, e));
    const score = scoreFromSimilarities(sims, TOP_K);
    if (score !== null) {
      return { score, source: "embedding", exemplarCount: exemplars.length };
    }
  }

  // 3. Fallback — today's LLM-vs-ICP comparison.
  const fb = await scoreCandidateForJob(jobId, candidate, tenantId);
  if (fb) return { score: fb.score, source: "fallback", exemplarCount: exemplars.length };
  return null;
}

/* ── Backtest gate + activation (offline; controlDb) ──────────────────────── */

interface SimilarHireLabeledRow extends LabeledRow {
  candidateId: string;
  jobId: string;
  candidate: {
    firstName?: string | null;
    lastName?: string | null;
    currentTitle?: string | null;
    currentCompany?: string | null;
    skills?: string[] | null;
    location?: string | null;
  };
}

/** Load a tenant's labeled rows enriched with candidate/job ids + profile fields
 *  so each row can be re-scored under BOTH the fallback and embedding strategies.
 *  Explicit tenant filter via controlDb. */
async function loadLabeledRowsForSimilarHire(tenantId: string): Promise<SimilarHireLabeledRow[]> {
  const rows = await controlDb
    .select({
      signalsJson: candidateJobIntelligenceTable.signalsJson,
      signalTimestampsJson: candidateJobIntelligenceTable.signalTimestampsJson,
      outcome: candidateJobIntelligenceTable.outcome,
      candidateId: candidateJobIntelligenceTable.candidateId,
      jobId: candidateJobIntelligenceTable.jobId,
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
      currentTitle: candidatesTable.currentTitle,
      currentCompany: candidatesTable.currentCompany,
      skills: candidatesTable.skills,
      location: candidatesTable.location,
    })
    .from(candidateJobIntelligenceTable)
    .innerJoin(candidatesTable, eq(candidatesTable.id, candidateJobIntelligenceTable.candidateId))
    .where(
      and(
        // Per-tenant labeled-row load, scoped via the canonical Class-B accessor.
        intelTenantScope([tenantId]),
        isNotNull(candidateJobIntelligenceTable.outcome),
      ),
    );

  const labeled: SimilarHireLabeledRow[] = [];
  for (const r of rows) {
    if (!r.outcome || !r.signalsJson) continue;
    labeled.push({
      signals: r.signalsJson as AgentSignals,
      timestamps: (r.signalTimestampsJson as SignalTimestamps) ?? {},
      outcome: r.outcome as HiringOutcome,
      candidateId: r.candidateId,
      jobId: r.jobId,
      candidate: {
        firstName: r.firstName,
        lastName: r.lastName,
        currentTitle: r.currentTitle,
        currentCompany: r.currentCompany,
        skills: r.skills,
        location: r.location,
      },
    });
  }
  return labeled;
}

/**
 * PURE: set (or, when score is null, clear) the similarHirePatternScore slice of
 * a signals object without mutating the input. This is the single place the
 * backtest arms differ, so it is unit-tested directly.
 */
export function withSimilarHire(signals: AgentSignals, score: number | null): AgentSignals {
  const rest = { ...(signals.analytics ?? {}) } as Record<string, unknown>;
  delete rest.similarHirePatternScore;
  if (score === null) {
    if (!signals.analytics) return signals;
    return { ...signals, analytics: rest as AgentSignals["analytics"] };
  }
  return { ...signals, analytics: { ...rest, similarHirePatternScore: score } as AgentSignals["analytics"] };
}

/**
 * Compute the embedding-based similarHirePatternScore for ONE labeled row using
 * the same gate as the live path (exemplars excluding self). Returns null when
 * the embedding path does not apply for that row (no role family, no stored
 * vector, or below the exemplar gate) — the caller then falls back exactly as
 * the runtime would.
 */
async function computeEmbeddingScoreForRow(
  tenantId: string,
  row: SimilarHireLabeledRow,
  minExemplars: number,
): Promise<number | null> {
  const roleFamily = await getRoleFamilyForJob(row.jobId, tenantId);
  if (!roleFamily) return null;
  const vector = await loadCandidateVector(tenantId, row.candidateId);
  if (!vector) return null;
  const exemplars = await loadSuccessfulHireVectors(tenantId, roleFamily, row.candidateId);
  if (exemplars.length < minExemplars) return null;
  const sims = exemplars.map((e) => cosineSimilarity(vector, e));
  return scoreFromSimilarities(sims, TOP_K);
}

function buildComparison(
  baseline: BacktestMetrics,
  candidate: BacktestMetrics,
  sampleSize: number,
  threshold: number,
): BacktestComparison {
  const insufficientData = sampleSize === 0;
  let winner: "candidate" | "live" | "tie" = "tie";
  if (!insufficientData) {
    const cF1 = candidate.f1, lF1 = baseline.f1;
    if (cF1 !== null && lF1 !== null && cF1 !== lF1) {
      winner = cF1 > lF1 ? "candidate" : "live";
    } else if (candidate.calibrationError !== baseline.calibrationError) {
      winner = candidate.calibrationError < baseline.calibrationError ? "candidate" : "live";
    }
  }
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const verdict = insufficientData
    ? "No labeled outcomes available — cannot evaluate the similar-hire signal yet."
    : winner === "tie"
      ? `The similar-hire embedding signal ties the fallback baseline on ${sampleSize} outcome(s).`
      : winner === "candidate"
        ? `The similar-hire embedding signal beats the fallback baseline on ${sampleSize} outcome(s).`
        : `The fallback baseline beats the similar-hire embedding signal on ${sampleSize} outcome(s).`;
  return {
    sampleSize,
    threshold,
    insufficientData,
    live: baseline,
    candidate,
    winner,
    verdict,
    deltas: {
      f1: candidate.f1 !== null && baseline.f1 !== null ? round3(candidate.f1 - baseline.f1) : null,
      precision:
        candidate.precision !== null && baseline.precision !== null
          ? round3(candidate.precision - baseline.precision)
          : null,
      recall:
        candidate.recall !== null && baseline.recall !== null
          ? round3(candidate.recall - baseline.recall)
          : null,
      calibrationError: round1(candidate.calibrationError - baseline.calibrationError),
    },
  };
}

/**
 * Re-score the tenant's labeled set under TWO strategies and return a
 * side-by-side comparison (same winner logic as the backtest harness: higher F1,
 * tie-break lower ECE):
 *   • baseline arm — the PERMANENT fallback: every row's similarHirePatternScore
 *     is the LLM-vs-ICP score ({@link scoreCandidateForJob}). This is what ships
 *     today / when the embedding signal is off.
 *   • candidate arm — the embedding strategy: each row uses the kNN embedding
 *     score when its role family clears the exemplar gate (excluding self), and
 *     otherwise falls back to the SAME LLM-vs-ICP score — exactly the runtime
 *     decision in {@link computeSimilarHirePatternScore}.
 * Activating the signal therefore requires it to beat the fallback strategy, not
 * merely a "no signal" baseline. Ensures embeddings exist for the labeled
 * candidates first so the comparison reflects the real corpus. Offline operation.
 */
export async function backtestSimilarHireSignal(
  tenantId: string,
  opts: { threshold?: number; minExemplars?: number } = {},
): Promise<BacktestComparison> {
  const threshold = opts.threshold ?? BACKTEST_THRESHOLD;
  const minExemplars = opts.minExemplars ?? MIN_HIRE_EXEMPLARS;
  const live = await getLiveScoringConfig();
  const labeled = await loadLabeledRowsForSimilarHire(tenantId);

  // Build the corpus: ensure every labeled candidate has a stored embedding.
  const uniqueCandidateIds = Array.from(new Set(labeled.map((r) => r.candidateId)));
  for (const cid of uniqueCandidateIds) {
    await ensureCandidateEmbedding(tenantId, cid);
  }

  // The LLM-vs-ICP fallback score is identical across both arms for a given
  // (job, candidate) — compute it once per row and reuse it for the baseline arm
  // and for any candidate-arm row that falls back.
  const fallbackCache = new Map<string, number | null>();
  const fallbackScoreFor = async (row: SimilarHireLabeledRow): Promise<number | null> => {
    const key = `${row.jobId}|${row.candidateId}`;
    if (fallbackCache.has(key)) return fallbackCache.get(key)!;
    const r = await scoreCandidateForJob(row.jobId, row.candidate, tenantId);
    const score = r ? r.score : null;
    fallbackCache.set(key, score);
    return score;
  };

  const baselineRows: LabeledRow[] = [];
  const candidateRows: LabeledRow[] = [];
  for (const r of labeled) {
    const fallbackScore = await fallbackScoreFor(r);
    const embeddingScore = await computeEmbeddingScoreForRow(tenantId, r, minExemplars);
    baselineRows.push({
      signals: withSimilarHire(r.signals, fallbackScore),
      timestamps: r.timestamps,
      outcome: r.outcome,
    });
    candidateRows.push({
      signals: withSimilarHire(r.signals, embeddingScore ?? fallbackScore),
      timestamps: r.timestamps,
      outcome: r.outcome,
    });
  }

  const baselineConfig: ScoringConfig = { ...live, label: "fallback baseline (LLM-vs-ICP)" };
  const candidateConfig: ScoringConfig = { ...live, label: "similar-hire embedding signal" };
  const baseline = scoreConfig(baselineConfig, baselineRows, threshold);
  const candidate = scoreConfig(candidateConfig, candidateRows, threshold);

  return buildComparison(baseline, candidate, labeled.length, threshold);
}

export interface SimilarHireTrainResult {
  tenantId: string;
  status: "promoted" | "rejected_by_backtest" | "insufficient_data";
  activated: boolean;
  minExemplars: number;
  sampleSize: number;
  comparison: BacktestComparison | null;
}

/**
 * Offline training/promotion entry point for one tenant. Runs the backtest gate
 * and ACTIVATES the embedding signal only when it beats the fallback baseline on
 * the tenant's own labeled outcomes; otherwise records it inactive. Idempotent:
 * upserts the single per-tenant activation row.
 */
export async function trainSimilarHireSignal(
  tenantId: string,
  opts: { threshold?: number; minExemplars?: number } = {},
): Promise<SimilarHireTrainResult> {
  const minExemplars = opts.minExemplars ?? MIN_HIRE_EXEMPLARS;
  const comparison = await backtestSimilarHireSignal(tenantId, { ...opts, minExemplars });

  const promote = !comparison.insufficientData && comparison.winner === "candidate";
  const status: SimilarHireTrainResult["status"] = comparison.insufficientData
    ? "insufficient_data"
    : promote
      ? "promoted"
      : "rejected_by_backtest";

  await controlDb
    .insert(similarHireModelsTable)
    .values({
      tenantId,
      isActive: promote,
      minExemplars,
      sampleSize: comparison.sampleSize,
      backtestJson: comparison,
      notes: comparison.verdict,
    })
    .onConflictDoUpdate({
      target: similarHireModelsTable.tenantId,
      set: {
        isActive: promote,
        minExemplars,
        sampleSize: comparison.sampleSize,
        backtestJson: comparison,
        notes: comparison.verdict,
        updatedAt: new Date(),
      },
    });

  if (promote) {
    logger.info({ tenantId, sampleSize: comparison.sampleSize }, "[similar-hire] signal promoted (beats fallback)");
  } else {
    logger.info({ tenantId, status }, "[similar-hire] signal not activated");
  }

  return { tenantId, status, activated: promote, minExemplars, sampleSize: comparison.sampleSize, comparison };
}

/** Deactivate the embedding signal for a tenant (revert to the LLM-vs-ICP
 *  fallback). Returns the number of rows changed. */
export async function deactivateSimilarHire(tenantId: string): Promise<number> {
  const rows = await controlDb
    .update(similarHireModelsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(similarHireModelsTable.tenantId, tenantId), eq(similarHireModelsTable.isActive, true)))
    .returning({ id: similarHireModelsTable.id });
  return rows.length;
}

/** Status for the admin route: the tunable gate, model id, and the tenant's
 *  current activation row (if any). */
export async function getSimilarHireStatus(tenantId: string) {
  const [row] = await controlDb
    .select()
    .from(similarHireModelsTable)
    .where(eq(similarHireModelsTable.tenantId, tenantId))
    .limit(1);
  return {
    tenantId,
    model: EMBEDDING_MODEL,
    gate: { minExemplars: MIN_HIRE_EXEMPLARS, topK: TOP_K, backtestThreshold: BACKTEST_THRESHOLD },
    active: !!row?.isActive,
    usingEmbeddingSignal: !!row?.isActive,
    model_row: row
      ? {
          isActive: row.isActive,
          minExemplars: row.minExemplars,
          sampleSize: row.sampleSize,
          notes: row.notes,
          updatedAt: row.updatedAt,
          backtest: row.backtestJson,
        }
      : null,
  };
}
