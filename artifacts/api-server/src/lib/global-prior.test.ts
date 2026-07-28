/**
 * global-prior.test.ts — Cross-tenant global scoring prior (Task #27)
 *
 * ─── What this asserts ────────────────────────────────────────────────────────
 * Two guarantees the network-effect prior must never break:
 *
 *  1. ISOLATION — the only thing that crosses a tenant boundary is per-dimension
 *     SUFFICIENT STATISTICS (sums/counts). The aggregate objects must carry NO
 *     candidate-level value and NO tenant identifier, and pooling those stats
 *     must be mathematically identical to computing over the concatenated raw
 *     rows (so the privacy-preserving aggregate loses no information).
 *
 *  2. SAFETY — the static builtin prior is the permanent fallback. selectMetaPrior
 *     / applyMetaPrior must fall back to builtin on every unhealthy condition (no
 *     row, below either gate, malformed weights), and the learned weight vector
 *     must stay valid (non-negative, sums≈1), shrink toward the prior on thin
 *     data, and collapse to the prior on degenerate data.
 *
 * These are pure-function tests — no DB. Run via:
 *   pnpm --filter @workspace/api-server run test:global
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulate,
  mergeDimStats,
  pearsonFromStats,
  rowsToAggregate,
  poolAggregates,
  weightsFromGlobalAggregate,
  selectMetaPrior,
  validateHireWeights,
  EMPTY_DIM_STATS,
  type DimensionStats,
  type TenantAggregate,
  type GlobalAggregate,
} from "./global-prior";
import { applyMetaPrior } from "./learned-scoring";
import { BUILTIN_LIVE_CONFIG, type ScoringConfig } from "./scoring-config";

const LIVE: ScoringConfig = BUILTIN_LIVE_CONFIG;
const PRIOR = LIVE.weights.hireProbability;

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Direct two-pass Pearson over raw (x,y) — the reference the sufficient-stat
 *  recovery must reproduce. */
function directPearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(vx * vy);
  return den > 0 ? cov / den : 0;
}

function statsFrom(xs: number[], ys: number[]): DimensionStats {
  let s = { ...EMPTY_DIM_STATS };
  for (let i = 0; i < xs.length; i++) s = accumulate(s, xs[i], ys[i]);
  return s;
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

/* ── pearsonFromStats vs direct ───────────────────────────────────────────── */

test("pearsonFromStats matches a direct two-pass Pearson", () => {
  const xs = [10, 30, 55, 70, 80, 95, 40, 60];
  const ys = [0, 0, 1, 1, 1, 1, 0, 1];
  const got = pearsonFromStats(statsFrom(xs, ys));
  assert.ok(approx(got, Math.max(-1, Math.min(1, directPearson(xs, ys))), 1e-9));
});

test("pearsonFromStats: zero variance → 0 (no NaN)", () => {
  const xs = [50, 50, 50, 50];
  const ys = [0, 1, 0, 1];
  assert.equal(pearsonFromStats(statsFrom(xs, ys)), 0);
});

test("pearsonFromStats: empty stats → 0", () => {
  assert.equal(pearsonFromStats({ ...EMPTY_DIM_STATS }), 0);
});

/* ── Pooling sufficient stats == computing over concatenated rows ──────────── */

test("mergeDimStats(poolA,poolB) Pearson == Pearson over concatenated rows", () => {
  const ax = [10, 20, 30, 40], ay = [0, 0, 1, 1];
  const bx = [55, 65, 75, 85, 95], by = [1, 0, 1, 1, 1];
  const merged = mergeDimStats(statsFrom(ax, ay), statsFrom(bx, by));
  const concat = statsFrom([...ax, ...bx], [...ay, ...by]);
  assert.ok(approx(pearsonFromStats(merged), pearsonFromStats(concat), 1e-9));
  assert.equal(merged.n, concat.n);
  assert.equal(merged.sumXY, concat.sumXY);
});

test("poolAggregates sums tenant aggregates element-wise and counts tenants", () => {
  const rowsA = [
    { fit: 80, quality: 70, trust: 60, conversion: 50, hired: 1 },
    { fit: 20, quality: 30, trust: 40, conversion: 50, hired: 0 },
  ];
  const rowsB = [
    { fit: 90, quality: 85, trust: 70, conversion: 60, hired: 1 },
    { fit: 10, quality: 20, trust: 30, conversion: 40, hired: 0 },
    { fit: 55, quality: 50, trust: 45, conversion: 40, hired: 1 },
  ];
  const aggA = rowsToAggregate(rowsA);
  const aggB = rowsToAggregate(rowsB);
  const pooled = poolAggregates([aggA, aggB]);
  // Pooled stats must equal aggregate of all rows concatenated (information-lossless).
  const concat = rowsToAggregate([...rowsA, ...rowsB]);
  assert.equal(pooled.contributingTenants, 2);
  assert.equal(pooled.sampleSize, concat.sampleSize);
  assert.equal(pooled.positives, concat.positives);
  for (const dim of ["fit", "quality", "trust", "conversion"] as const) {
    assert.ok(approx(pearsonFromStats(pooled[dim]), pearsonFromStats(concat[dim]), 1e-9), `${dim} pooled==concat`);
    assert.equal(pooled[dim].n, concat[dim].n);
    assert.equal(pooled[dim].sumXY, concat[dim].sumXY);
  }
});

/* ── ISOLATION: aggregate shapes carry no candidate/tenant identifiers ─────── */

const FORBIDDEN_KEYS = [
  "tenantId", "tenant_id", "candidateId", "candidate_id", "id",
  "name", "email", "phone", "userId", "user_id", "applicationId",
];

test("ISOLATION: TenantAggregate has only numeric sufficient-stat fields", () => {
  const agg: TenantAggregate = rowsToAggregate([
    { fit: 80, quality: 70, trust: 60, conversion: 50, hired: 1 },
    { fit: 20, quality: 30, trust: 40, conversion: 50, hired: 0 },
  ]);
  const topKeys = Object.keys(agg);
  for (const k of FORBIDDEN_KEYS) assert.ok(!topKeys.includes(k), `top-level key must not be ${k}`);
  // Every leaf value is a finite number — no strings/ids could ride along.
  for (const dim of ["fit", "quality", "trust", "conversion"] as const) {
    for (const [sk, sv] of Object.entries(agg[dim])) {
      assert.equal(typeof sv, "number", `${dim}.${sk} must be a number`);
      assert.ok(Number.isFinite(sv as number));
    }
  }
  assert.equal(typeof agg.sampleSize, "number");
  assert.equal(typeof agg.positives, "number");
});

test("ISOLATION: pooled GlobalAggregate exposes no identifier fields", () => {
  const pooled: GlobalAggregate = poolAggregates([
    rowsToAggregate([{ fit: 80, quality: 70, trust: 60, conversion: 50, hired: 1 }]),
    rowsToAggregate([{ fit: 10, quality: 20, trust: 30, conversion: 40, hired: 0 }]),
  ]);
  const topKeys = Object.keys(pooled);
  for (const k of FORBIDDEN_KEYS) assert.ok(!topKeys.includes(k), `global key must not be ${k}`);
  // Only contributingTenants is non-dimension scalar metadata — and it is a count.
  assert.equal(typeof pooled.contributingTenants, "number");
});

/* ── weightsFromGlobalAggregate: valid, shrinks, degenerate→prior ─────────── */

/** Build a strongly-predictive global aggregate with `n` samples where fit
 *  correlates with the hire label far more than the other dimensions. */
function predictiveAggregate(n: number): GlobalAggregate {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const hired = i % 2 === 0 ? 1 : 0;
    rows.push({
      fit: hired ? 90 : 10,            // strong signal
      quality: 50 + (i % 5),           // noise
      trust: 50,                       // flat
      conversion: hired ? 55 : 45,     // weak signal
      hired,
    });
  }
  return poolAggregates([rowsToAggregate(rows)]);
}

test("weightsFromGlobalAggregate: weights non-negative and sum≈1", () => {
  const { weights, degenerate } = weightsFromGlobalAggregate(predictiveAggregate(400), PRIOR, 200);
  assert.equal(degenerate, false);
  const sum = weights.fit + weights.quality + weights.trust + weights.conversion;
  assert.ok(approx(sum, 1, 1e-3), `sum=${sum}`);
  for (const v of Object.values(weights)) assert.ok(v >= 0);
});

test("weightsFromGlobalAggregate: large N moves further from prior than small N", () => {
  const small = weightsFromGlobalAggregate(predictiveAggregate(30), PRIOR, 200).weights;
  const large = weightsFromGlobalAggregate(predictiveAggregate(4000), PRIOR, 200).weights;
  const dist = (w: typeof PRIOR) =>
    Math.abs(w.fit - PRIOR.fit) + Math.abs(w.quality - PRIOR.quality) +
    Math.abs(w.trust - PRIOR.trust) + Math.abs(w.conversion - PRIOR.conversion);
  assert.ok(dist(large) > dist(small), `large(${dist(large)}) should exceed small(${dist(small)})`);
});

test("weightsFromGlobalAggregate: empty/degenerate → prior unchanged", () => {
  const empty = weightsFromGlobalAggregate(poolAggregates([]), PRIOR, 200);
  assert.equal(empty.degenerate, true);
  assert.deepEqual(empty.weights, PRIOR);

  // All dimensions flat → zero variance → no positive correlation → prior.
  const flat = poolAggregates([rowsToAggregate([
    { fit: 50, quality: 50, trust: 50, conversion: 50, hired: 1 },
    { fit: 50, quality: 50, trust: 50, conversion: 50, hired: 0 },
  ])]);
  const flatRes = weightsFromGlobalAggregate(flat, PRIOR, 200);
  assert.equal(flatRes.degenerate, true);
  assert.deepEqual(flatRes.weights, PRIOR);
});

/* ── selectMetaPrior: builtin fallback on every unhealthy condition ───────── */

const GOOD_META = { priorJson: { fit: 0.4, quality: 0.3, trust: 0.2, conversion: 0.1 }, sampleSize: 100, contributingTenants: 3 };

test("selectMetaPrior: null row → fallback prior", () => {
  const got = selectMetaPrior({ meta: null, fallbackPrior: PRIOR, minSamples: 50, minTenants: 2 });
  assert.equal(got, PRIOR);
});

test("selectMetaPrior: below sample gate → fallback", () => {
  const got = selectMetaPrior({ meta: { ...GOOD_META, sampleSize: 10 }, fallbackPrior: PRIOR, minSamples: 50, minTenants: 2 });
  assert.equal(got, PRIOR);
});

test("selectMetaPrior: below tenant gate → fallback", () => {
  const got = selectMetaPrior({ meta: { ...GOOD_META, contributingTenants: 1 }, fallbackPrior: PRIOR, minSamples: 50, minTenants: 2 });
  assert.equal(got, PRIOR);
});

test("selectMetaPrior: malformed priorJson → fallback", () => {
  const got = selectMetaPrior({ meta: { ...GOOD_META, priorJson: { fit: "x" } }, fallbackPrior: PRIOR, minSamples: 50, minTenants: 2 });
  assert.equal(got, PRIOR);
});

test("selectMetaPrior: healthy row → returns the meta weights", () => {
  const got = selectMetaPrior({ meta: GOOD_META, fallbackPrior: PRIOR, minSamples: 50, minTenants: 2 });
  assert.deepEqual(got, GOOD_META.priorJson);
});

/* ── validateHireWeights ──────────────────────────────────────────────────── */

test("validateHireWeights: rejects non-objects, negatives, NaN, all-zero", () => {
  assert.equal(validateHireWeights(null), null);
  assert.equal(validateHireWeights("nope"), null);
  assert.equal(validateHireWeights({ fit: 0.5, quality: 0.5, trust: 0.5 }), null); // missing conversion
  assert.equal(validateHireWeights({ fit: -0.1, quality: 0.4, trust: 0.4, conversion: 0.3 }), null);
  assert.equal(validateHireWeights({ fit: NaN, quality: 0.4, trust: 0.4, conversion: 0.2 }), null);
  assert.equal(validateHireWeights({ fit: 0, quality: 0, trust: 0, conversion: 0 }), null);
  assert.deepEqual(validateHireWeights({ fit: 0.4, quality: 0.3, trust: 0.2, conversion: 0.1 }), { fit: 0.4, quality: 0.3, trust: 0.2, conversion: 0.1 });
});

/* ── applyMetaPrior: pure cold-start substitution / permanent fallback ─────── */

test("applyMetaPrior: null meta → returns live unchanged (same reference)", () => {
  const got = applyMetaPrior(LIVE, null);
  assert.equal(got, LIVE);
});

test("applyMetaPrior: substitutes ONLY hireProbability + stamps version", () => {
  const meta = { weights: { fit: 0.5, quality: 0.2, trust: 0.2, conversion: 0.1 }, version: "global-prior-123" };
  const got = applyMetaPrior(LIVE, meta);
  assert.deepEqual(got.weights.hireProbability, meta.weights);
  assert.ok(got.version.includes("gp:global-prior-123"), `version stamped: ${got.version}`);
  // Every other weight group is preserved byte-for-byte.
  for (const k of Object.keys(LIVE.weights)) {
    if (k === "hireProbability") continue;
    assert.deepEqual((got.weights as any)[k], (LIVE.weights as any)[k], `weights.${k} preserved`);
  }
  // The live config object is not mutated.
  assert.deepEqual(LIVE.weights.hireProbability, PRIOR);
});
