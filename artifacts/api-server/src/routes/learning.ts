/**
 * routes/learning.ts — Closed-Loop Intelligence Learning API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Provides analytics endpoints that close the feedback loop between hiring
 * outcomes and the AI agents that generated the decisions. The Learning page
 * shows recruiters which model signals actually predicted hires and which were
 * noise — enabling data-driven policy tuning.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET /source-quality       Which candidate sources produce the most hires?
 *                             Breaks down hired / rejected / ghosted counts by
 *                             candidate.source (linkedin, github, referral, etc.)
 *   GET /score-correlation    How well does each AI score dimension predict
 *                             the final outcome? Correlates fitScore, qualityScore,
 *                             trustScore, conversionScore against outcome labels.
 *   GET /signal-coverage      Which candidates reached each signal (screening,
 *                             interview, verification) vs. how many were hired?
 *                             Reveals which agents are bottlenecks.
 *   GET /policy-performance   For each tenant decision policy, how many advances /
 *                             holds / rejects were made and what were their outcomes?
 *   GET /ai-recommendations   GPT-4o-generated suggestions for improving each
 *                             agent's configuration based on the above data.
 *
 * ─── Closed-loop principle ───────────────────────────────────────────────────
 * All analysis is computed on-the-fly from candidate_job_intelligence rows
 * that have a non-null outcome (set by POST /intelligence/…/outcome when a
 * recruiter records a hire, rejection, ghost, etc.). The more outcomes are
 * recorded, the richer the learning signal becomes.
 *
 * ─── Mounted at ──────────────────────────────────────────────────────────────
 *   routes/index.ts mounts this router at /api/learning/*
 */

import { Router } from "express";
import { z } from "zod";
import { db, controlDb } from "@workspace/db";
import {
  candidateJobIntelligenceTable,
  candidatesTable,
  applicationsTable,
  jobsTable,
  usersTable,
} from "@workspace/db";
import { eq, isNotNull, and, desc, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { resolveUser } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { getAuthUserId } from "../lib/auth-token";
import {
  listScoringVersions,
  createScoringVersion,
  activateScoringVersion,
  getScoringVersion,
  validateScoringConfig,
  type ScoringConfig,
} from "../lib/scoring-config";
import { runBacktest } from "../lib/backtest";
import { getAllowedTenantIds } from "../lib/tenantUtils";
import {
  trainTenantWeights,
  deactivateLearnedVersions,
  listLearnedVersions,
  getActiveLearnedRow,
  MIN_SAMPLES,
  SHRINKAGE_K,
  BACKTEST_THRESHOLD,
} from "../lib/learned-scoring";
import {
  trainSimilarHireSignal,
  deactivateSimilarHire,
  getSimilarHireStatus,
} from "../lib/similar-hire";
import {
  trainGlobalPrior,
  deactivateGlobalPriors,
  getActiveGlobalPrior,
  listGlobalPriorVersions,
  MIN_TENANT_SAMPLES as GP_MIN_TENANT_SAMPLES,
  MIN_CONTRIBUTING_TENANTS as GP_MIN_TENANTS,
  MIN_TOTAL_SAMPLES as GP_MIN_TOTAL_SAMPLES,
  SHRINKAGE_K as GP_SHRINKAGE_K,
} from "../lib/global-prior";

const router = Router();

/* ── Staff gating ─────────────────────────────────────────────────────────────
 * The learning router is mounted WITHOUT global auth and relies on RLS for
 * tenant isolation. The scoring-version endpoints below mutate platform-global
 * configuration / run cross-cutting analytics, so they each resolve the caller
 * and enforce an explicit role allowlist — getAllowedTenantIds is NOT a staff
 * gate (users.tenant_id is NOT NULL for candidates too). */
const STAFF_ROLES = ["platform_admin", "tenant_admin", "recruiter", "hiring_manager"];
const ADMIN_ROLES = ["platform_admin"];

async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/** Resolve caller and require one of `roles`. Returns the user or null (after
 *  having already written the 401/403 response). */
async function requireRole(req: any, res: any, roles: string[]) {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!roles.includes(user.role)) { res.status(403).json({ error: "Forbidden" }); return null; }
  return user;
}

/* Tenant-scoping predicate for the cross-tenant analytics reads below.
 * candidate_job_intelligence is NOT an RLS-protected table (it is absent from
 * every RLS migration), so the request-scoped `db` proxy does NOT filter it by
 * tenant. These analytics GETs therefore MUST apply an explicit tenant
 * predicate or they leak aggregate learning signals across tenants.
 *
 * `allowed` comes from getAllowedTenantIds(user):
 *   null            → platform_admin: no filter (sees all tenants)
 *   []              → no tenant scope at all: match nothing (fail closed)
 *   [tenant, …]     → restrict to the caller's own tenant subtree
 * Returns a drizzle condition, or undefined for the no-filter (platform) case
 * so it can be dropped into `and(...)`/`.where(...)` transparently. */
function cjiTenantScope(allowed: string[] | null) {
  if (allowed === null) return undefined;
  return inArray(candidateJobIntelligenceTable.tenantId, allowed.length ? allowed : ["__none__"]);
}

/* ── GET /learning/source-quality ────────────────────────────────────────── */
router.get("/source-quality", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const allowed = await getAllowedTenantIds(user);
    // Join intelligence outcomes with candidate source
    const rows = await db
      .select({
        source:          candidatesTable.source,
        outcome:         candidateJobIntelligenceTable.outcome,
        hireProbability: candidateJobIntelligenceTable.hireProbability,
        fitScore:        candidateJobIntelligenceTable.fitScore,
        qualityScore:    candidateJobIntelligenceTable.qualityScore,
        trustScore:      candidateJobIntelligenceTable.trustScore,
      })
      .from(candidateJobIntelligenceTable)
      .innerJoin(candidatesTable, eq(candidatesTable.id, candidateJobIntelligenceTable.candidateId))
      .where(cjiTenantScope(allowed))
      .orderBy(desc(candidateJobIntelligenceTable.hireProbability));

    // Aggregate by source
    const sourceMap = new Map<string, {
      total: number; hired: number; rejected: number; ghosted: number;
      avgHireProbability: number; avgFit: number; avgQuality: number; avgTrust: number;
    }>();

    for (const row of rows) {
      const src = row.source ?? "unknown";
      if (!sourceMap.has(src)) {
        sourceMap.set(src, { total: 0, hired: 0, rejected: 0, ghosted: 0, avgHireProbability: 0, avgFit: 0, avgQuality: 0, avgTrust: 0 });
      }
      const s = sourceMap.get(src)!;
      s.total++;
      s.avgHireProbability += row.hireProbability ?? 50;
      s.avgFit   += row.fitScore     ?? 50;
      s.avgQuality += row.qualityScore ?? 50;
      s.avgTrust += row.trustScore   ?? 50;
      if (row.outcome === "hired" || row.outcome === "offer_accepted") s.hired++;
      else if (row.outcome === "rejected") s.rejected++;
      else if (row.outcome === "ghosted") s.ghosted++;
    }

    const data = Array.from(sourceMap.entries()).map(([source, s]) => ({
      source,
      total:            s.total,
      hired:            s.hired,
      rejected:         s.rejected,
      ghosted:          s.ghosted,
      hireRate:         s.total > 0 ? Math.round((s.hired / s.total) * 100) : null,
      avgHireProbability: Math.round(s.avgHireProbability / s.total),
      avgFitScore:      Math.round(s.avgFit / s.total),
      avgQualityScore:  Math.round(s.avgQuality / s.total),
      avgTrustScore:    Math.round(s.avgTrust / s.total),
    })).sort((a, b) => (b.hireRate ?? 0) - (a.hireRate ?? 0));

    res.json({ data });
  } catch (err: any) {
    logger.error({ err }, "Failed to compute source quality");
    res.status(500).json({ error: "Failed to compute source quality" });
  }
});

/* ── GET /learning/score-correlation ─────────────────────────────────────── */
router.get("/score-correlation", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const allowed = await getAllowedTenantIds(user);
    const rows = await db
      .select({
        fitScore:        candidateJobIntelligenceTable.fitScore,
        qualityScore:    candidateJobIntelligenceTable.qualityScore,
        trustScore:      candidateJobIntelligenceTable.trustScore,
        conversionScore: candidateJobIntelligenceTable.conversionScore,
        hireProbability: candidateJobIntelligenceTable.hireProbability,
        outcome:         candidateJobIntelligenceTable.outcome,
      })
      .from(candidateJobIntelligenceTable)
      .where(and(isNotNull(candidateJobIntelligenceTable.outcome), cjiTenantScope(allowed)));

    if (rows.length < 3) {
      return res.json({
        data: {
          correlations: {},
          message: "Insufficient outcome data for correlation analysis — need at least 3 labelled outcomes",
        },
      });
    }

    // Pearson correlation between each dimension and a binary "hired" flag
    function pearson(xs: number[], ys: number[]): number {
      const n = xs.length;
      if (n === 0) return 0;
      const meanX = xs.reduce((s, v) => s + v, 0) / n;
      const meanY = ys.reduce((s, v) => s + v, 0) / n;
      const num   = xs.reduce((s, v, i) => s + (v - meanX) * (ys[i] - meanY), 0);
      const denX  = Math.sqrt(xs.reduce((s, v) => s + (v - meanX) ** 2, 0));
      const denY  = Math.sqrt(ys.reduce((s, v) => s + (v - meanY) ** 2, 0));
      return denX * denY === 0 ? 0 : parseFloat((num / (denX * denY)).toFixed(3));
    }

    const hiredBinary = rows.map(r => (r.outcome === "hired" || r.outcome === "offer_accepted") ? 1 : 0);
    const fit         = rows.map(r => r.fitScore ?? 50);
    const quality     = rows.map(r => r.qualityScore ?? 50);
    const trust       = rows.map(r => r.trustScore ?? 50);
    const conversion  = rows.map(r => r.conversionScore ?? 50);
    const hireProbAll = rows.map(r => r.hireProbability ?? 50);

    const correlations = {
      fitScore:        { r: pearson(fit, hiredBinary),        label: "Fit Score",        description: "How well role requirements match" },
      qualityScore:    { r: pearson(quality, hiredBinary),    label: "Quality Score",    description: "Screening + interview caliber" },
      trustScore:      { r: pearson(trust, hiredBinary),      label: "Trust Score",      description: "Identity & integrity signals" },
      conversionScore: { r: pearson(conversion, hiredBinary), label: "Conversion Score", description: "Engagement & completion likelihood" },
      hireProbability: { r: pearson(hireProbAll, hiredBinary),label: "Hire Probability", description: "Composite prediction" },
    };

    // Sort by absolute correlation (strongest predictor first)
    const sorted = Object.entries(correlations).sort((a, b) => Math.abs(b[1].r) - Math.abs(a[1].r));
    const strongestPredictor = sorted[0]?.[1]?.label ?? "Hire Probability";

    res.json({
      data: {
        correlations,
        strongestPredictor,
        sampleSize: rows.length,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to compute score correlation");
    res.status(500).json({ error: "Failed to compute score correlation" });
  }
});

/* ── GET /learning/agent-coverage ────────────────────────────────────────── */
router.get("/agent-coverage", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const allowed = await getAllowedTenantIds(user);
    const rows = await db
      .select({
        signalsJson:     candidateJobIntelligenceTable.signalsJson,
        outcome:         candidateJobIntelligenceTable.outcome,
        hireProbability: candidateJobIntelligenceTable.hireProbability,
      })
      .from(candidateJobIntelligenceTable)
      .where(cjiTenantScope(allowed));

    const agents = ["screening", "sourcing", "interview", "proctoring", "outreach", "antiGhosting", "verification", "scheduling", "analytics"] as const;

    const coverageMap = agents.map(agent => {
      const withAgent    = rows.filter(r => (r.signalsJson as any)?.[agent] !== undefined);
      const withoutAgent = rows.filter(r => (r.signalsJson as any)?.[agent] === undefined);
      const avgHpWith    = withAgent.length > 0 ? Math.round(withAgent.reduce((s, r) => s + (r.hireProbability ?? 50), 0) / withAgent.length) : null;
      const avgHpWithout = withoutAgent.length > 0 ? Math.round(withoutAgent.reduce((s, r) => s + (r.hireProbability ?? 50), 0) / withoutAgent.length) : null;
      const hiredWith    = withAgent.filter(r => r.outcome === "hired" || r.outcome === "offer_accepted").length;
      const hiredWithout = withoutAgent.filter(r => r.outcome === "hired" || r.outcome === "offer_accepted").length;
      const hireRateWith    = withAgent.length > 0 ? Math.round((hiredWith / withAgent.length) * 100)    : null;
      const hireRateWithout = withoutAgent.length > 0 ? Math.round((hiredWithout / withoutAgent.length) * 100) : null;
      const coverageRate    = rows.length > 0 ? Math.round((withAgent.length / rows.length) * 100) : 0;

      return {
        agent,
        coverageRate,
        countWith:    withAgent.length,
        countWithout: withoutAgent.length,
        avgHireProbabilityWith:    avgHpWith,
        avgHireProbabilityWithout: avgHpWithout,
        hireRateWith,
        hireRateWithout,
        impact: avgHpWith !== null && avgHpWithout !== null ? avgHpWith - avgHpWithout : null,
      };
    }).sort((a, b) => Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0));

    res.json({ data: coverageMap, totalCandidates: rows.length });
  } catch (err: any) {
    logger.error({ err }, "Failed to compute agent coverage");
    res.status(500).json({ error: "Failed to compute agent coverage" });
  }
});

/* ── GET /learning/recommendations ───────────────────────────────────────── */
router.get("/recommendations", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const allowed = await getAllowedTenantIds(user);
    // Fetch all intelligence records and their outcomes
    const intel = await db
      .select({
        signalsJson:     candidateJobIntelligenceTable.signalsJson,
        overridesJson:   candidateJobIntelligenceTable.overridesJson,
        outcome:         candidateJobIntelligenceTable.outcome,
        fitScore:        candidateJobIntelligenceTable.fitScore,
        qualityScore:    candidateJobIntelligenceTable.qualityScore,
        trustScore:      candidateJobIntelligenceTable.trustScore,
        conversionScore: candidateJobIntelligenceTable.conversionScore,
        hireProbability: candidateJobIntelligenceTable.hireProbability,
        nextBestAction:  candidateJobIntelligenceTable.nextBestAction,
        tenantId:        candidateJobIntelligenceTable.tenantId,
      })
      .from(candidateJobIntelligenceTable)
      .where(cjiTenantScope(allowed))
      .orderBy(desc(candidateJobIntelligenceTable.lastUpdated));

    const withOutcomes = intel.filter(r => r.outcome);
    const hiredRows    = withOutcomes.filter(r => r.outcome === "hired" || r.outcome === "offer_accepted");
    const totalOutcomes = withOutcomes.length;
    const totalRecords  = intel.length;

    const recommendations: Array<{
      agent:       string;
      category:    "sourcing" | "outreach" | "interview" | "policy" | "verification";
      priority:    "high" | "medium" | "low";
      title:       string;
      description: string;
      evidence:    string;
      suggestedAction: string;
    }> = [];

    // Coverage gaps → increase agent priority
    const agentGaps = [
      { agent: "screening",    field: "screening",    label: "Screening",    impact: "fundamental — drives Fit and Quality scores" },
      { agent: "verification", field: "verification", label: "Verification", impact: "required to unlock >80% confidence decisions" },
      { agent: "interview",    field: "interview",    label: "Interview",    impact: "elevates confidence and unlocks offer-stage decisions" },
      { agent: "antiGhosting", field: "antiGhosting", label: "Anti-Ghosting",impact: "predicts drop-off before offers are made" },
    ];

    for (const { agent, field, label, impact } of agentGaps) {
      const missing = intel.filter(r => !(r.signalsJson as any)?.[field]).length;
      const missingPct = Math.round((missing / Math.max(totalRecords, 1)) * 100);
      if (missingPct > 40) {
        recommendations.push({
          agent,
          category: agent === "antiGhosting" ? "outreach" : agent === "interview" ? "interview" : "sourcing",
          priority: missingPct > 70 ? "high" : "medium",
          title: `${label} signals missing for ${missingPct}% of candidates`,
          description: `${missingPct}% of candidates have no ${label} data — this is ${impact}.`,
          evidence: `${missing} of ${totalRecords} candidates lack ${label} signals`,
          suggestedAction: `Ensure the ${label} Agent runs for all new candidates entering the pipeline.`,
        });
      }
    }

    // Override patterns → suggest policy adjustments
    let totalOverrides = 0;
    let advanceOverrides = 0;
    for (const row of intel) {
      const overrides = (row.overridesJson as any[]) ?? [];
      totalOverrides += overrides.length;
      advanceOverrides += overrides.filter((o: any) => o.recruiterDecision === "advance").length;
    }

    if (totalOverrides > 3) {
      const overrideRate = Math.round((totalOverrides / Math.max(totalRecords, 1)) * 100);
      if (overrideRate > 20) {
        recommendations.push({
          agent: "policy",
          category: "policy",
          priority: "medium",
          title: "High override rate suggests policy miscalibration",
          description: `Recruiters are overriding AI recommendations ${overrideRate}% of the time. This may indicate that thresholds are set too conservatively.`,
          evidence: `${totalOverrides} overrides across ${totalRecords} candidates (${overrideRate}% rate)`,
          suggestedAction: "Review the tenant policy thresholds. If most overrides advance candidates, consider lowering advanceThreshold by 5–10 points.",
        });
      }
    }

    // Source quality → guide sourcing agent
    const sourceCounts = new Map<string, { total: number; hired: number }>();
    for (const row of withOutcomes) {
      // we don't have source here without joining, skip this for now
    }

    // Confidence distribution → identify data gaps
    const lowConfidence = intel.filter(r => {
      const signals = r.signalsJson as any;
      return !signals?.screening || !signals?.interview;
    }).length;
    if (lowConfidence > 0) {
      const pct = Math.round((lowConfidence / totalRecords) * 100);
      recommendations.push({
        agent: "screening",
        category: "sourcing",
        priority: "high",
        title: `${pct}% of candidates lack screening or interview data`,
        description: "Without these critical signals, the engine is confidence-capped and cannot make high-confidence decisions.",
        evidence: `${lowConfidence} candidates are missing screening or interview agent signals`,
        suggestedAction: "Ensure the Screening Agent and Interview Agent are triggered automatically for all applied candidates.",
      });
    }

    // Hire probability distribution
    const avgHp = intel.length > 0
      ? Math.round(intel.reduce((s, r) => s + (r.hireProbability ?? 50), 0) / intel.length)
      : 50;

    if (avgHp < 50 && totalRecords > 5) {
      recommendations.push({
        agent: "sourcing",
        category: "sourcing",
        priority: "medium",
        title: "Pipeline-wide hire probability is below 50%",
        description: `The average hire probability across all candidates is ${avgHp}%, suggesting the sourcing pipeline may need better targeting.`,
        evidence: `Avg hire probability: ${avgHp}% across ${totalRecords} candidates`,
        suggestedAction: "Review ICP requirements and sourcing channels. Focus sourcing on candidates with higher baseline fit scores.",
      });
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    res.json({
      data: {
        recommendations,
        summary: {
          totalRecords,
          totalOutcomes,
          hiredCount: hiredRows.length,
          avgHireProbability: avgHp,
          overrideCount: totalOverrides,
        },
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate recommendations");
    res.status(500).json({ error: "Failed to generate recommendations" });
  }
});

/* ── GET /learning/predicted-vs-actual ───────────────────────────────────── */
router.get("/predicted-vs-actual", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const allowed = await getAllowedTenantIds(user);
    const rows = await db
      .select({
        hireProbability: candidateJobIntelligenceTable.hireProbability,
        outcome:         candidateJobIntelligenceTable.outcome,
        nextBestAction:  candidateJobIntelligenceTable.nextBestAction,
        fitScore:        candidateJobIntelligenceTable.fitScore,
        qualityScore:    candidateJobIntelligenceTable.qualityScore,
        trustScore:      candidateJobIntelligenceTable.trustScore,
        conversionScore: candidateJobIntelligenceTable.conversionScore,
      })
      .from(candidateJobIntelligenceTable)
      .where(cjiTenantScope(allowed))
      .orderBy(desc(candidateJobIntelligenceTable.hireProbability));

    // Bucket into deciles for calibration chart
    const buckets: Record<string, { predicted: number; actualHired: number; total: number }> = {};
    for (let i = 0; i <= 90; i += 10) {
      buckets[`${i}-${i + 9}`] = { predicted: i + 5, actualHired: 0, total: 0 };
    }

    for (const row of rows) {
      const hp = row.hireProbability ?? 50;
      const bucket = `${Math.floor(hp / 10) * 10}-${Math.floor(hp / 10) * 10 + 9}`;
      if (buckets[bucket]) {
        buckets[bucket].total++;
        if (row.outcome === "hired" || row.outcome === "offer_accepted") buckets[bucket].actualHired++;
      }
    }

    const calibrationData = Object.entries(buckets).map(([range, b]) => ({
      range,
      predicted: b.predicted,
      actualRate: b.total > 0 ? Math.round((b.actualHired / b.total) * 100) : null,
      count: b.total,
    }));

    // Per-action outcome breakdown
    const actionOutcomes: Record<string, { action: string; hired: number; rejected: number; ghosted: number; total: number }> = {};
    for (const row of rows) {
      const action = row.nextBestAction ?? "unknown";
      if (!actionOutcomes[action]) actionOutcomes[action] = { action, hired: 0, rejected: 0, ghosted: 0, total: 0 };
      actionOutcomes[action].total++;
      if (row.outcome === "hired" || row.outcome === "offer_accepted") actionOutcomes[action].hired++;
      else if (row.outcome === "rejected") actionOutcomes[action].rejected++;
      else if (row.outcome === "ghosted") actionOutcomes[action].ghosted++;
    }

    res.json({
      data: {
        calibrationData,
        actionOutcomes: Object.values(actionOutcomes),
        totalRecords: rows.length,
        withOutcomes: rows.filter(r => r.outcome).length,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to compute predicted vs actual");
    res.status(500).json({ error: "Failed to compute predicted vs actual" });
  }
});

/* ── Scoring model versioning & backtest ──────────────────────────────────────
 * These endpoints let a platform operator inspect scoring versions, register a
 * candidate weight set, backtest it against real historical outcomes, and
 * promote (or roll back to) a version. NOTE: the candidate config is a deeply
 * nested object — `validate()` would strip unknown nested keys, so config
 * bodies are validated manually via validateScoringConfig() instead. */

/* GET /learning/scoring-versions — list all registered versions (staff). */
router.get("/scoring-versions", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const versions = await listScoringVersions();
    res.json({ data: versions });
  } catch (err: any) {
    logger.error({ err }, "Failed to list scoring versions");
    res.status(500).json({ error: "Failed to list scoring versions" });
  }
});

/* POST /learning/scoring-versions — register a candidate version (admin).
 * Body: { config: ScoringConfig, notes?: string }. Does NOT make it live. */
router.post("/scoring-versions", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  try {
    let config: ScoringConfig;
    try {
      config = validateScoringConfig((req.body ?? {}).config);
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Invalid scoring config" });
      return;
    }
    const notes = typeof req.body?.notes === "string" ? req.body.notes : undefined;
    const created = await createScoringVersion(config, notes);
    logger.info({ version: created.version, by: user.id }, "Scoring version registered");
    res.status(201).json({ data: created });
  } catch (err: any) {
    // Duplicate version → 409, everything else → 500
    if (typeof err?.message === "string" && err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error({ err }, "Failed to create scoring version");
    res.status(500).json({ error: "Failed to create scoring version" });
  }
});

/* POST /learning/scoring-versions/:version/activate — promote or roll back to a
 * version (admin). This changes the config used to score+persist all new rows. */
router.post("/scoring-versions/:version/activate", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  const version = req.params.version;
  try {
    const exists = await getScoringVersion(version);
    if (!exists) { res.status(404).json({ error: `Scoring version "${version}" not found` }); return; }
    await activateScoringVersion(version);
    logger.info({ version, by: user.id }, "Scoring version activated");
    res.json({ data: { version, isLive: true } });
  } catch (err: any) {
    logger.error({ err, version }, "Failed to activate scoring version");
    res.status(500).json({ error: "Failed to activate scoring version" });
  }
});

/* POST /learning/backtest — replay historical labeled outcomes under a candidate
 * config vs the live config (staff). Body: { version?: string, config?:
 * ScoringConfig, threshold?: number }. Provide either a stored `version` or an
 * inline `config`. */
const BacktestBody = z.object({ threshold: z.number().min(0).max(100).optional() });
router.post("/backtest", resolveUser, validate({ body: BacktestBody.passthrough() }), async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const body = req.body ?? {};
    let candidate: ScoringConfig;
    if (typeof body.version === "string" && body.version.trim()) {
      const stored = await getScoringVersion(body.version);
      if (!stored) { res.status(404).json({ error: `Scoring version "${body.version}" not found` }); return; }
      candidate = stored;
    } else if (body.config) {
      try {
        candidate = validateScoringConfig(body.config);
      } catch (e: any) {
        res.status(400).json({ error: e?.message ?? "Invalid scoring config" });
        return;
      }
    } else {
      res.status(400).json({ error: "Provide either a stored `version` or an inline `config` to backtest" });
      return;
    }

    const threshold = typeof body.threshold === "number" ? body.threshold : undefined;
    const result = await runBacktest(candidate, { threshold });
    res.json({ data: result });
  } catch (err: any) {
    logger.error({ err }, "Failed to run backtest");
    res.status(500).json({ error: "Failed to run backtest" });
  }
});

/* ── Per-tenant learned scoring weights ───────────────────────────────────────
 * Outcome-calibrated learned `hireProbability` weights (Task #25). Training is a
 * platform ML operation that changes which config scores a whole tenant, so it
 * is platform_admin-only (mirrors the scoring-version mutation routes). Reading
 * status is open to staff. A learned config only activates after clearing the
 * sample gate AND beating the live config on the backtest — see lib/learned-
 * scoring.ts. The hardcoded model remains the permanent fallback. */

/** Resolve the target tenant for a learned-weights mutation and authorize it.
 *  platform_admin may target any tenant via body.tenantId; others are confined
 *  to their own allowed subtree. Returns null after writing the error response. */
async function resolveTargetTenant(req: any, res: any, user: any): Promise<string | null> {
  const raw = typeof req.body?.tenantId === "string" ? req.body.tenantId.trim() : "";
  const target = raw || user.tenantId;
  if (!target) { res.status(400).json({ error: "No tenant could be resolved for this request" }); return null; }
  const allowed = await getAllowedTenantIds(user);
  if (allowed !== null && !allowed.includes(target)) {
    res.status(403).json({ error: "Forbidden: tenant outside your scope" });
    return null;
  }
  return target;
}

/* GET /learning/tenant-weights — status for a tenant: the tunable sample gate,
 * the currently active learned config (if any), and the version history (staff).
 * Tenant via ?tenantId= (platform_admin may inspect any; others their subtree). */
router.get("/tenant-weights", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const raw = typeof req.query.tenantId === "string" ? req.query.tenantId.trim() : "";
    const target = raw || user.tenantId;
    if (!target) { res.status(400).json({ error: "No tenant could be resolved for this request" }); return; }
    const allowed = await getAllowedTenantIds(user);
    if (allowed !== null && !allowed.includes(target)) {
      res.status(403).json({ error: "Forbidden: tenant outside your scope" });
      return;
    }
    const [active, versions] = await Promise.all([
      getActiveLearnedRow(target),
      listLearnedVersions(target),
    ]);
    res.json({
      data: {
        tenantId: target,
        gate: { minSamples: MIN_SAMPLES, shrinkageK: SHRINKAGE_K, backtestThreshold: BACKTEST_THRESHOLD },
        active: active
          ? { version: active.version, sampleSize: active.sampleSize, isActive: active.isActive }
          : null,
        usingLearnedConfig: !!active,
        versions,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to read tenant learned-weights status");
    res.status(500).json({ error: "Failed to read tenant learned-weights status" });
  }
});

/* POST /learning/tenant-weights/train — learn + backtest-gate a tenant's weights
 * (admin). Body: { tenantId?: string, threshold?: number }. Activates the learned
 * config ONLY if it clears the sample gate and beats the live config. */
router.post("/tenant-weights/train", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  try {
    const tenantId = await resolveTargetTenant(req, res, user);
    if (!tenantId) return;
    const threshold = typeof req.body?.threshold === "number" ? req.body.threshold : undefined;
    const result = await trainTenantWeights(tenantId, { threshold });
    logger.info({ tenantId, status: result.status, by: user.id }, "Tenant learned-weights training run");
    res.json({ data: result });
  } catch (err: any) {
    logger.error({ err }, "Failed to train tenant learned weights");
    res.status(500).json({ error: "Failed to train tenant learned weights" });
  }
});

/* POST /learning/tenant-weights/deactivate — revert a tenant to the live /
 * hardcoded config by deactivating all learned versions (admin).
 * Body: { tenantId?: string }. */
router.post("/tenant-weights/deactivate", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  try {
    const tenantId = await resolveTargetTenant(req, res, user);
    if (!tenantId) return;
    const deactivated = await deactivateLearnedVersions(tenantId);
    logger.info({ tenantId, deactivated, by: user.id }, "Tenant learned-weights deactivated");
    res.json({ data: { tenantId, deactivated, usingLearnedConfig: false } });
  } catch (err: any) {
    logger.error({ err }, "Failed to deactivate tenant learned weights");
    res.status(500).json({ error: "Failed to deactivate tenant learned weights" });
  }
});

/* ── Per-tenant similar-hire embedding signal ─────────────────────────────────
 * Real similar-hire signal (Task #26): the ICP-pattern slice of fitScore via kNN
 * cosine similarity against a tenant's real successful hires. Like learned
 * weights, the embedding signal only ships for a tenant after the backtest
 * confirms it beats the permanent LLM-vs-ICP fallback — training is a platform ML
 * operation, so it is platform_admin-only; reading status is open to staff. */

/* GET /learning/similar-hire — status for a tenant: the tunable exemplar gate,
 * the embedding model, and whether the signal is currently active. Tenant via
 * ?tenantId= (platform_admin may inspect any; others their subtree). */
router.get("/similar-hire", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const raw = typeof req.query.tenantId === "string" ? req.query.tenantId.trim() : "";
    const target = raw || user.tenantId;
    if (!target) { res.status(400).json({ error: "No tenant could be resolved for this request" }); return; }
    const allowed = await getAllowedTenantIds(user);
    if (allowed !== null && !allowed.includes(target)) {
      res.status(403).json({ error: "Forbidden: tenant outside your scope" });
      return;
    }
    const status = await getSimilarHireStatus(target);
    res.json({ data: status });
  } catch (err: any) {
    logger.error({ err }, "Failed to read similar-hire status");
    res.status(500).json({ error: "Failed to read similar-hire status" });
  }
});

/* POST /learning/similar-hire/train — backtest-gate + activate a tenant's
 * embedding signal (admin). Body: { tenantId?: string, threshold?: number,
 * minExemplars?: number }. Activates ONLY if the embedding signal beats the
 * fallback baseline on the tenant's labeled outcomes. */
router.post("/similar-hire/train", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  try {
    const tenantId = await resolveTargetTenant(req, res, user);
    if (!tenantId) return;
    const threshold = typeof req.body?.threshold === "number" ? req.body.threshold : undefined;
    const minExemplars = typeof req.body?.minExemplars === "number" ? req.body.minExemplars : undefined;
    const result = await trainSimilarHireSignal(tenantId, { threshold, minExemplars });
    logger.info({ tenantId, status: result.status, by: user.id }, "Similar-hire signal training run");
    res.json({ data: result });
  } catch (err: any) {
    logger.error({ err }, "Failed to train similar-hire signal");
    res.status(500).json({ error: "Failed to train similar-hire signal" });
  }
});

/* POST /learning/similar-hire/deactivate — revert a tenant to the LLM-vs-ICP
 * fallback by deactivating the embedding signal (admin). Body: { tenantId?:
 * string }. */
router.post("/similar-hire/deactivate", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  try {
    const tenantId = await resolveTargetTenant(req, res, user);
    if (!tenantId) return;
    const deactivated = await deactivateSimilarHire(tenantId);
    logger.info({ tenantId, deactivated, by: user.id }, "Similar-hire signal deactivated");
    res.json({ data: { tenantId, deactivated, usingEmbeddingSignal: false } });
  } catch (err: any) {
    logger.error({ err }, "Failed to deactivate similar-hire signal");
    res.status(500).json({ error: "Failed to deactivate similar-hire signal" });
  }
});

/* ── Cross-tenant global scoring prior (network effect) ───────────────────────
 * A platform-global meta-prior for the four hireProbability composite weights,
 * learned from ANONYMIZED, AGGREGATED sufficient statistics pooled across tenants
 * (never candidate-level data). New / thin-data tenants initialize their
 * cold-start prior from the active row instead of the static builtin. Training is
 * a cross-tenant platform ML operation (platform_admin-only); reading the
 * anonymized status is open to staff. There is NO tenant parameter — this is a
 * single platform-wide resource. The static builtin remains the permanent
 * fallback whenever no meta-prior is active. */

/* GET /learning/global-prior — anonymized status: the activation gates, the
 * active meta-prior (version, pooled sample size, contributing-tenant count, the
 * weight vector), and the version history (staff). */
router.get("/global-prior", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, STAFF_ROLES);
  if (!user) return;
  try {
    const [active, versions] = await Promise.all([
      getActiveGlobalPrior(),
      listGlobalPriorVersions(),
    ]);
    res.json({
      data: {
        gate: {
          minTenants: GP_MIN_TENANTS,
          minTotalSamples: GP_MIN_TOTAL_SAMPLES,
          minTenantSamples: GP_MIN_TENANT_SAMPLES,
          shrinkageK: GP_SHRINKAGE_K,
        },
        active: active
          ? {
              version: active.version,
              sampleSize: active.sampleSize,
              contributingTenants: active.contributingTenants,
              prior: active.priorJson,
            }
          : null,
        usingGlobalPrior: !!active,
        versions,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to read global-prior status");
    res.status(500).json({ error: "Failed to read global-prior status" });
  }
});

/* POST /learning/global-prior/train — aggregate sufficient statistics across all
 * tenants, learn a shrunk meta-prior, and federated-evaluate it (admin). Body:
 * { threshold?: number, shrinkageK?: number, minTenantSamples?: number }.
 * Activates the meta-prior ONLY if it clears the contributing-tenant + total-
 * sample gates, is non-degenerate, AND shows net improvement in the per-tenant
 * federated evaluation. No candidate-level data crosses a tenant boundary. */
router.post("/global-prior/train", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  try {
    const threshold = typeof req.body?.threshold === "number" ? req.body.threshold : undefined;
    const shrinkageK = typeof req.body?.shrinkageK === "number" ? req.body.shrinkageK : undefined;
    const minTenantSamples = typeof req.body?.minTenantSamples === "number" ? req.body.minTenantSamples : undefined;
    const result = await trainGlobalPrior({ threshold, shrinkageK, minTenantSamples });
    logger.info({ status: result.status, activated: result.activated, by: user.id }, "Global-prior training run");
    res.json({ data: result });
  } catch (err: any) {
    logger.error({ err }, "Failed to train global prior");
    res.status(500).json({ error: "Failed to train global prior" });
  }
});

/* POST /learning/global-prior/deactivate — revert every tenant's cold-start to
 * the static builtin prior by deactivating all meta-prior versions (admin). */
router.post("/global-prior/deactivate", resolveUser, async (req, res) => {
  const user = await requireRole(req, res, ADMIN_ROLES);
  if (!user) return;
  try {
    const deactivated = await deactivateGlobalPriors();
    logger.info({ deactivated, by: user.id }, "Global-prior deactivated");
    res.json({ data: { deactivated, usingGlobalPrior: false } });
  } catch (err: any) {
    logger.error({ err }, "Failed to deactivate global prior");
    res.status(500).json({ error: "Failed to deactivate global prior" });
  }
});

export default router;
