/**
 * routes/intelligence.ts — Candidate Intelligence & Decision Policy API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Exposes the candidate_job_intelligence table and the decision-policy engine
 * to the frontend. The Intelligence page shows recruiters an AI-scored view of
 * every candidate-job pair: fit score, hire probability, next best action, and
 * an outcome-calibrated stage-progression forecast.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /intelligence                    List all intelligence rows (tenant-scoped)
 *                                         enriched with candidate + job names
 *   GET  /intelligence/:jobId/:candidateId  Get or compute one pair's intelligence
 *   POST /intelligence/:jobId/:candidateId  Manually upsert an intelligence row
 *   POST /intelligence/:jobId/:candidateId/decide  Run decideNextAction() for this pair
 *                                          (returns the recommended action + reason)
 *   POST /intelligence/:jobId/:candidateId/outcome  Record a hiring outcome
 *                                          (triggers outcome-calibrated model update)
 *   POST /intelligence/:jobId/:candidateId/override  Save a recruiter override
 *                                          (tracks drift between AI and human decisions)
 *   GET  /intelligence/insights            Platform-wide learning insights:
 *                                          policy performance, ghosting correlation,
 *                                          model calibration, top risk factors
 *   GET  /intelligence/policy             Current tenant decision policy
 *   PUT  /intelligence/policy             Update + validate the tenant decision policy
 *
 * ─── Score semantics ─────────────────────────────────────────────────────────
 *   fitScore        — ICP match quality (0–100)
 *   qualityScore    — Resume/interview quality signals (0–100)
 *   trustScore      — Verification confidence (0–100)
 *   conversionScore — Historical conversion rate for similar profiles (0–100)
 *   hireProbability — outcome-calibrated P(hire | signals) (0–1)
 *
 * ─── Policy system ───────────────────────────────────────────────────────────
 * The decision policy (stored in tenant_decision_policies) is a JSONB blob of
 * thresholds (advance, hold, reject per score dimension). validatePolicy()
 * runs structural checks before saving so invalid policies never reach production.
 */
import { Router } from "express";
import { z } from "zod";
import { validate } from "../middlewares/validate";

const VALID_ACTIONS_LIST = [
  "advance",
  "schedule",
  "recruiter_review",
  "re_engage",
  "manual_verification",
  "reject",
  "hold",
] as const;
const VALID_OUTCOMES_LIST = [
  "hired",
  "rejected",
  "ghosted",
  "no_show",
  "offer_accepted",
  "offer_declined",
] as const;

const PolicyUpdateBody = z.object({
  policy: z.unknown(),
  roleId: z.string().optional(),
  stage: z.string().optional(),
  label: z.string().optional(),
});

const ComputeIntelligenceBody = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  signals: z.record(z.unknown()).optional(),
});

const TriggerActionBody = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  force: z.string().optional(),
});

const OverrideBody = z.object({
  originalDecision: z.enum(VALID_ACTIONS_LIST),
  recruiterDecision: z.enum(VALID_ACTIONS_LIST),
  recruiterReason: z.string().min(3),
  /* EU AI Act Art. 14 — mandatory free-text rationale in the recruiter's own
   * words (a category label alone is not sufficient human-oversight evidence). */
  reasonDetail: z
    .string()
    .trim()
    .min(10, "A written rationale of at least 10 characters is required"),
  recruiterId: z.string().optional(),
});

const FeedbackBody = z.object({
  rating: z.enum(["positive", "negative"]),
});

const OutcomeBody = z.object({
  outcome: z.enum(VALID_OUTCOMES_LIST),
});
import {
  getIntelligenceForJob,
  getIntelligenceForPair,
  upsertIntelligence,
  computeScores,
  decideNextAction,
  recordOutcome,
  recordOverride,
  getLearningInsights,
  computeStageProbs,
  computeConfidence,
  decayFactor,
  DEFAULT_POLICY as _DEFAULT_POLICY,
} from "../lib/intelligence";
import { getPolicy, savePolicy, validatePolicy, DEFAULT_POLICY } from "../lib/policies";
import { db } from "@workspace/db";
import {
  candidateJobIntelligenceTable,
  candidatesTable,
  jobsTable,
  tenantDecisionPoliciesTable,
  tenantScoringWeightsTable,
  similarHireModelsTable,
} from "@workspace/db";
import { MIN_SAMPLES } from "../lib/learned-scoring";
import { MIN_HIRE_EXEMPLARS } from "../lib/similar-hire";
import { eq, and, desc, isNotNull, inArray } from "drizzle-orm";
import { rankWithStaleness } from "../lib/staleness.js";
import { restrictToCompliantCandidates } from "../lib/compliance-scope.js";
import { intelTenantScope } from "../lib/class-b-access";
import { logger } from "../lib/logger";
import { orchestrator } from "../lib/agents/orchestrator";
import { resolveUser } from "../middlewares/resolveUser";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { enforceOwnership } from "../lib/ownership";

const router = Router();

/* All /intelligence/* routes require an authenticated user. The previous
   version left several handlers without a guard — anyone with the URL could
   read cross-tenant intelligence rows and policies. Mounting resolveUser at
   the router level makes the auth check unbypassable per route. */
router.use(resolveUser);

/* Helper: confirm the caller's tenant owns the job referenced in the URL.
   Returns true to allow the handler to proceed; sends 404 + returns false
   on mismatch. We respond 404 (not 403) to avoid leaking job existence to
   other tenants. */
/* Subtree-aware tenant gate: own tenant + ALL descendants via the shared
   helper (null = platform_admin, no restriction). A null row tenantId is
   treated as accessible (legacy rows). */
async function canAccessTenant(
  user: { id: string; role: string; tenantId: string | null },
  tenantId: string | null | undefined,
): Promise<boolean> {
  const allowed = await getDataScopeTenantIds(user);
  if (allowed === null) return true;
  if (!tenantId) return true;
  return allowed.includes(tenantId);
}

/* Canonical Class-B tenant scope for candidate_job_intelligence reads/writes.
 * null  → platform_admin: no filter
 * []    → fail closed (match nothing)
 * [...] → restrict to the caller's data scope */
function cjiTenantScope(allowed: string[] | null) {
  if (allowed === null) return undefined;
  return inArray(candidateJobIntelligenceTable.tenantId, allowed.length ? allowed : ["__none__"]);
}

async function assertJobOwnership(req: any, res: any, jobId: string): Promise<boolean> {
  const user = req.resolvedUser!;
  const [job] = await db
    .select({ tenantId: jobsTable.tenantId })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  if (!(await canAccessTenant(user, job.tenantId))) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

/* Confirm the candidate row exists AND belongs to the caller's tenant.
   Without this, a recruiter who knows another tenant's candidate ID could
   bind that candidate into their own intelligence/outreach pipeline,
   exposing PII via downstream JOINs. Candidates can live in either the
   normalised `candidates` table or the recruiter-sourced staging table —
   we try both before declaring the candidate a stranger. */
async function assertCandidateOwnership(req: any, res: any, candidateId: string): Promise<boolean> {
  const user = req.resolvedUser!;
  if (user.role === "platform_admin") return true;
  const [c] = await db
    .select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId))
    .limit(1);
  if (c) {
    if (!(await canAccessTenant(user, c.tenantId))) {
      res.status(404).json({ error: "Not found" });
      return false;
    }
    return true;
  }
  /* Fall back to sourced_candidates (recruiter-imported leads). */
  const { sourcedCandidatesTable } = await import("@workspace/db");
  const [sc] = await db
    .select({ tenantId: sourcedCandidatesTable.tenantId })
    .from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.id, candidateId))
    .limit(1);
  if (!sc) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  if (!(await canAccessTenant(user, sc.tenantId))) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

const VALID_OUTCOMES = [
  "hired",
  "rejected",
  "ghosted",
  "no_show",
  "offer_accepted",
  "offer_declined",
] as const;
const VALID_ACTIONS = [
  "advance",
  "schedule",
  "recruiter_review",
  "re_engage",
  "manual_verification",
  "reject",
  "hold",
] as const;

/* ── GET /intelligence ─────────────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const user = req.resolvedUser!;
    const allowed = await getDataScopeTenantIds(user);
    const rows = await db
      .select({
        id: candidateJobIntelligenceTable.id,
        tenantId: candidateJobIntelligenceTable.tenantId,
        jobId: candidateJobIntelligenceTable.jobId,
        candidateId: candidateJobIntelligenceTable.candidateId,
        fitScore: candidateJobIntelligenceTable.fitScore,
        qualityScore: candidateJobIntelligenceTable.qualityScore,
        trustScore: candidateJobIntelligenceTable.trustScore,
        conversionScore: candidateJobIntelligenceTable.conversionScore,
        hireProbability: candidateJobIntelligenceTable.hireProbability,
        nextBestAction: candidateJobIntelligenceTable.nextBestAction,
        topStrengths: candidateJobIntelligenceTable.topStrengths,
        topRisks: candidateJobIntelligenceTable.topRisks,
        explanationJson: candidateJobIntelligenceTable.explanationJson,
        signalsJson: candidateJobIntelligenceTable.signalsJson,
        signalTimestampsJson: candidateJobIntelligenceTable.signalTimestampsJson,
        stageProbsJson: candidateJobIntelligenceTable.stageProbsJson,
        overridesJson: candidateJobIntelligenceTable.overridesJson,
        outcome: candidateJobIntelligenceTable.outcome,
        outcomeAt: candidateJobIntelligenceTable.outcomeAt,
        lastUpdated: candidateJobIntelligenceTable.lastUpdated,
        candidateFirstName: candidatesTable.firstName,
        candidateLastName: candidatesTable.lastName,
        candidateEmail: candidatesTable.email,
        candidateTitle: candidatesTable.currentTitle,
        candidateCompany: candidatesTable.currentCompany,
        candidateUpdatedAt: candidatesTable.updatedAt,
        candidateLinkedin: candidatesTable.linkedinUrl,
        jobTitle: jobsTable.title,
        jobDepartment: jobsTable.department,
      })
      .from(candidateJobIntelligenceTable)
      .leftJoin(candidatesTable, eq(candidatesTable.id, candidateJobIntelligenceTable.candidateId))
      .leftJoin(jobsTable, eq(jobsTable.id, candidateJobIntelligenceTable.jobId))
      .where(
        and(
          /* Tenant scope pushed INTO the DB read via the canonical Class-B
           accessor. candidate_job_intelligence is NON-RLS, so this predicate —
           platform_admin (null) ⇒ all rows; recruiter_admin ⇒ assigned client
           sub-tenants; everyone else ⇒ their tenant subtree — is the seal. */
          intelTenantScope(allowed),
          // Compliance: never surface GDPR-erased / do-not-contact candidates.
          restrictToCompliantCandidates(candidateJobIntelligenceTable.candidateId),
        ),
      )
      .orderBy(desc(candidateJobIntelligenceTable.hireProbability));

    let scoped = rows;

    /* A plain recruiter is additionally ceilinged to requisitions ASSIGNED to
       them. Tenant scope alone would leak peer recruiters' candidates within
       the same tenant — mirror the by-id enforceOwnership gate for the list. */
    if (user.role === "recruiter") {
      const assigned = new Set(await getRecruiterAssignedJobIds(user));
      scoped = scoped.filter((r) => r.jobId && assigned.has(r.jobId));
    }

    /* Evidence enrichment (presentation only — no score recompute): surface how
       much signal actually backs each hireProbability so the UI can show a
       confidence band and an honest "insufficient data" state instead of a bare
       confident-looking percentage. */
    const enriched = scoped.map((r) => {
      const signals = (r.signalsJson as any) ?? {};
      const timestamps = (r.signalTimestampsJson as any) ?? {};
      const conf = computeConfidence(signals, timestamps);
      return { ...r, confidence: conf.total, signalCount: conf.signalCount };
    });

    /* Staleness-adjusted RANKING (lib/staleness.ts): read-time demotion of
       inactive candidates — stored hireProbability is untouched; only the
       ordering (and transparency fields) reflect recency. lastActive =
       candidate.updatedAt (sanctioned recency proxy for non-platform rows). */
    const ranked = rankWithStaleness(
      enriched,
      (r) => Number(r.hireProbability ?? 0),
      (r) => r.candidateUpdatedAt,
    ).map((x) => ({
      ...x.item,
      rankScore: x.rankScore,
      stalenessMultiplier: x.stalenessMultiplier,
      daysInactive: x.daysInactive,
    }));

    res.json({ data: ranked });
  } catch (err: any) {
    logger.error({ err }, "Failed to list intelligence records");
    res.status(500).json({ error: "Failed to fetch intelligence records" });
  }
});

/* ── GET /intelligence/job/:jobId ─────────────────────────────────────────── */
router.get("/job/:jobId", enforceOwnership({ kinds: ["jobId"] }), async (req, res) => {
  try {
    const user = req.resolvedUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    /* Verify the caller can see this job's tenant. */
    const [job] = await db
      .select({ tenantId: jobsTable.tenantId })
      .from(jobsTable)
      .where(eq(jobsTable.id, req.params.jobId))
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!(await canAccessTenant(user, job.tenantId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const records = await getIntelligenceForJob(
      req.params.jobId,
      await getDataScopeTenantIds(user),
    );
    res.json({ data: records });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch job intelligence");
    res.status(500).json({ error: "Failed to fetch intelligence records" });
  }
});

/* ── GET /intelligence/candidate/:candidateId ─────────────────────────────── */
router.get(
  "/candidate/:candidateId",
  enforceOwnership({ kinds: ["candidateId"] }),
  async (req, res) => {
    try {
      const user = req.resolvedUser;
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const { candidateId } = req.params;
      const [cand] = await db
        .select({ tenantId: candidatesTable.tenantId })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, candidateId))
        .limit(1);
      if (!cand) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (!(await canAccessTenant(user, cand.tenantId))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      /* Cross-tenant seal — candidate_job_intelligence is NON-RLS, so the db proxy
       does NOT tenant-filter it. canAccessTenant above only authorises the
       CANDIDATE row, but a single candidate can carry intelligence rows scored
       against OTHER tenants' jobs (cross-tenant / platform-pool scoring writes
       the JOB's tenant). Without an explicit predicate this endpoint leaked a
       sibling/parent tenant's job relationship + fit/hire scores. Scope the
       returned rows to the caller's tenant subtree; platform_admin (null) sees all. */
      const allowed = await getDataScopeTenantIds(user);
      const records = await db
        .select()
        .from(candidateJobIntelligenceTable)
        .where(
          and(
            eq(candidateJobIntelligenceTable.candidateId, candidateId),
            restrictToCompliantCandidates(candidateJobIntelligenceTable.candidateId),
            /* Canonical Class-B tenant seal (same inArray, expressed through the
           accessor so the guard sees a scope-helper, not a bare column). */
            intelTenantScope(allowed),
          ),
        )
        .orderBy(desc(candidateJobIntelligenceTable.lastUpdated));

      /* A plain recruiter is additionally ceilinged to requisitions ASSIGNED to
       them — tenant scope alone would leak a peer recruiter's job-intel for the
       same candidate within the shared tenant. Mirrors the GET / list gate. */
      let scoped = records;
      if (user.role === "recruiter") {
        const assigned = new Set(await getRecruiterAssignedJobIds(user));
        scoped = records.filter((r) => r.jobId && assigned.has(r.jobId));
      }
      res.json({ data: scoped });
    } catch (err: any) {
      logger.error({ err }, "Failed to fetch candidate intelligence");
      res.status(500).json({ error: "Failed to fetch intelligence records" });
    }
  },
);

/* ── GET /intelligence/outcomes/learning ──────────────────────────────────── */
/* Platform-wide learning insights leak hiring outcomes across tenants and
   are intended only for the Lexy ops team. Restrict to platform_admin. */
router.get("/outcomes/learning", async (req, res) => {
  if (req.resolvedUser?.role !== "platform_admin") {
    return res.status(404).json({ error: "Not found" });
  }
  return _learningInsightsHandler(req, res);
});
async function _learningInsightsHandler(req: any, res: any) {
  try {
    const insights = await getLearningInsights();
    res.json({ data: insights });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch learning insights");
    res.status(500).json({ error: "Failed to compute learning insights" });
  }
}

/* ── GET /intelligence/scoring-status ─────────────────────────────────────────
 * Recruiter-facing transparency: is the SMARTER, learned scoring active for any
 * tenant in the caller's data scope, and is the similar-hire pattern signal
 * activated? Aggregate booleans + sample sizes only — never weights, never
 * candidate rows. Static route: MUST stay registered before /:jobId/:candidateId. */
router.get("/scoring-status", async (req, res) => {
  try {
    const user = req.resolvedUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const allowed = await getDataScopeTenantIds(user);
    if (allowed?.length === 0) {
      res.json({
        learnedScoring: { active: false, tenants: 0, maxSampleSize: 0, minSamples: MIN_SAMPLES },
        similarHire: { active: false, tenants: 0, minExemplars: MIN_HIRE_EXEMPLARS },
      });
      return;
    }
    /* tenant_scoring_weights / similar_hire_models are non-RLS learning tables —
     * explicit tenant predicate required (allowed=null means platform-wide scope). */
    const learnedConds = [eq(tenantScoringWeightsTable.isActive, true)];
    if (allowed) learnedConds.push(inArray(tenantScoringWeightsTable.tenantId, allowed));
    const learnedRows = await db
      .select({ sampleSize: tenantScoringWeightsTable.sampleSize })
      .from(tenantScoringWeightsTable)
      .where(and(...learnedConds));

    const simConds = [eq(similarHireModelsTable.isActive, true)];
    if (allowed) simConds.push(inArray(similarHireModelsTable.tenantId, allowed));
    const simRows = await db
      .select({ sampleSize: similarHireModelsTable.sampleSize })
      .from(similarHireModelsTable)
      .where(and(...simConds));

    res.json({
      learnedScoring: {
        active: learnedRows.length > 0,
        tenants: learnedRows.length,
        maxSampleSize: learnedRows.reduce((m, r) => Math.max(m, r.sampleSize ?? 0), 0),
        minSamples: MIN_SAMPLES,
      },
      similarHire: {
        active: simRows.length > 0,
        tenants: simRows.length,
        minExemplars: MIN_HIRE_EXEMPLARS,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch scoring status");
    res.status(500).json({ error: "Failed to fetch scoring status" });
  }
});

/* ── GET /intelligence/policies/:tenantId ──────────────────────────────────── */
router.get("/policies/:tenantId", async (req, res) => {
  try {
    const user = req.resolvedUser!;
    const { tenantId } = req.params;
    if (!(await canAccessTenant(user, tenantId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { roleId, stage } = req.query as { roleId?: string; stage?: string };

    const policy = await getPolicy(tenantId, roleId, stage);

    // Also return all stored policies for this tenant
    const stored = await db
      .select()
      .from(tenantDecisionPoliciesTable)
      .where(eq(tenantDecisionPoliciesTable.tenantId, tenantId));

    res.json({
      data: {
        resolved: policy,
        stored: stored.map((r) => ({
          id: r.id,
          label: r.label,
          roleId: r.roleId,
          stage: r.stage,
          isDefault: r.isDefault,
          policy: r.policyJson,
          updatedAt: r.updatedAt,
        })),
        defaults: DEFAULT_POLICY,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch tenant policy");
    res.status(500).json({ error: "Failed to fetch tenant policy" });
  }
});

/* ── PUT /intelligence/policies/:tenantId ──────────────────────────────────── */
router.put("/policies/:tenantId", validate({ body: PolicyUpdateBody }), async (req, res) => {
  try {
    const user = req.resolvedUser!;
    const { tenantId } = req.params;
    if (!(await canAccessTenant(user, tenantId))) {
      return res.status(404).json({ error: "Not found" });
    }
    const {
      policy: policyRaw,
      roleId,
      stage,
      label,
    } = req.body as {
      policy?: unknown;
      roleId?: string;
      stage?: string;
      label?: string;
    };

    if (!policyRaw) {
      return res.status(400).json({ error: "policy object is required in request body" });
    }

    const { valid, errors, policy } = validatePolicy(policyRaw);
    if (!valid || !policy) {
      return res.status(400).json({ error: "Invalid policy", details: errors });
    }

    await savePolicy(tenantId, policy, { roleId, stage, label });
    logger.info({ tenantId, roleId, stage }, "Tenant policy saved");
    res.json({ success: true, policy });
  } catch (err: any) {
    logger.error({ err }, "Failed to save tenant policy");
    res.status(500).json({ error: "Failed to save policy" });
  }
});

/* ── GET /intelligence/:jobId/:candidateId ────────────────────────────────── */
router.get(
  "/:jobId/:candidateId",
  enforceOwnership({ kinds: ["jobId", "candidateId"] }),
  async (req, res) => {
    try {
      const user = req.resolvedUser!;
      const record = await getIntelligenceForPair(
        req.params.jobId,
        req.params.candidateId,
        await getDataScopeTenantIds(user),
      );
      if (!record)
        return res.status(404).json({ error: "No intelligence record found for this pair" });
      // Defense-in-depth: the SQL scope above already excludes out-of-scope rows;
      // this second check is a redundant belt-and-suspenders, kept intentionally.
      if (!(await canAccessTenant(user, record.tenantId))) {
        return res.status(404).json({ error: "No intelligence record found for this pair" });
      }

      let decisionResult = null;
      if (record.signalsJson) {
        const scores = {
          fitScore: record.fitScore ?? 50,
          qualityScore: record.qualityScore ?? 50,
          trustScore: record.trustScore ?? 50,
          conversionScore: record.conversionScore ?? 50,
          hireProbability: record.hireProbability ?? 50,
        };
        const policy = await getPolicy(record.tenantId);
        const timestamps = (record.signalTimestampsJson as any) ?? {};
        decisionResult = decideNextAction(scores, record.signalsJson as any, timestamps, policy);
      }

      res.json({ data: { ...record, decisionResult } });
    } catch (err: any) {
      logger.error({ err }, "Failed to fetch pair intelligence");
      res.status(500).json({ error: "Failed to fetch intelligence record" });
    }
  },
);

/* ── GET /intelligence/:jobId/:candidateId/decision ──────────────────────── */
router.get(
  "/:jobId/:candidateId/decision",
  enforceOwnership({ kinds: ["jobId", "candidateId"] }),
  async (req, res) => {
    try {
      const user = req.resolvedUser!;
      const record = await getIntelligenceForPair(
        req.params.jobId,
        req.params.candidateId,
        await getDataScopeTenantIds(user),
      );
      if (!record) return res.status(404).json({ error: "No intelligence record found" });
      // Defense-in-depth: SQL scope already excludes out-of-scope rows; redundant.
      if (!(await canAccessTenant(user, record.tenantId))) {
        return res.status(404).json({ error: "No intelligence record found" });
      }

      /* Neutral-50 coercion is for the INTERNAL decision/stage-prob math only —
       the response's `scores` must be the RAW stored values (nullable) so every
       UI surface renders the same record identically ("—" for unknown), instead
       of the detail view fabricating a 50 the summary card never shows. */
      const computeScoresInput = {
        fitScore: record.fitScore ?? 50,
        qualityScore: record.qualityScore ?? 50,
        trustScore: record.trustScore ?? 50,
        conversionScore: record.conversionScore ?? 50,
        hireProbability: record.hireProbability ?? 50,
      };
      const scores = {
        fitScore: record.fitScore,
        qualityScore: record.qualityScore,
        trustScore: record.trustScore,
        conversionScore: record.conversionScore,
        hireProbability: record.hireProbability,
      };

      const policy = await getPolicy(record.tenantId);
      const timestamps = (record.signalTimestampsJson as any) ?? {};
      const signals = (record.signalsJson as any) ?? {};

      const decisionResult = decideNextAction(computeScoresInput, signals, timestamps, policy);
      const confidenceBreak = computeConfidence(signals, timestamps);
      const stageProbs = computeStageProbs(computeScoresInput, signals);

      // Signal freshness summary per agent
      const agentKeys = [
        "screening",
        "sourcing",
        "interview",
        "proctoring",
        "outreach",
        "antiGhosting",
        "verification",
        "scheduling",
        "analytics",
      ] as const;
      const signalFreshness = agentKeys.map((k) => ({
        agent: k,
        present: !!signals[k],
        decay: signals[k] ? Math.round(decayFactor(k, timestamps) * 100) : null,
        lastUpdated: timestamps[k] ?? null,
      }));

      res.json({
        data: {
          jobId: req.params.jobId,
          candidateId: req.params.candidateId,
          hireProbability: record.hireProbability,
          scores,
          stageProbs,
          decisionResult,
          confidenceBreakdown: confidenceBreak,
          signalFreshness,
          overrides: (record.overridesJson as any[]) ?? [],
          policy,
          lastUpdated: record.lastUpdated,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Failed to compute decision");
      res.status(500).json({ error: "Failed to compute decision" });
    }
  },
);

/* ── POST /intelligence/compute ───────────────────────────────────────────── */
router.post(
  "/compute",
  validate({ body: ComputeIntelligenceBody }),
  enforceOwnership({ kinds: ["jobId", "candidateId"] }),
  async (req, res) => {
    try {
      const user = req.resolvedUser!;
      const { jobId, candidateId, signals } = req.body as {
        jobId?: string;
        candidateId?: string;
        signals?: Record<string, any>;
      };

      if (!jobId || !candidateId) {
        return res.status(400).json({ error: "jobId and candidateId are required" });
      }
      /* Verified caller's tenant — never trust a body-provided tenantId, never
       fall back to "demo". Confirm the job belongs to the caller. */
      if (!(await assertJobOwnership(req, res, jobId))) return;
      if (!(await assertCandidateOwnership(req, res, candidateId))) return;
      const tenantId = user.tenantId;
      if (!tenantId) return res.status(403).json({ error: "Forbidden: no tenant context" });

      const result = await upsertIntelligence(tenantId, jobId, candidateId, signals ?? {});
      res.json({ data: result });
    } catch (err: any) {
      logger.error({ err }, "Failed to compute intelligence");
      res.status(400).json({ error: err?.message ?? "Failed to compute intelligence" });
    }
  },
);

/* ── POST /intelligence/trigger-action ───────────────────────────────────── */
router.post(
  "/trigger-action",
  validate({ body: TriggerActionBody }),
  enforceOwnership({ kinds: ["jobId", "candidateId"] }),
  async (req, res) => {
    try {
      const { jobId, candidateId, force } = req.body as {
        jobId?: string;
        candidateId?: string;
        force?: string;
      };

      if (!jobId || !candidateId) {
        return res.status(400).json({ error: "jobId and candidateId are required" });
      }
      if (!(await assertJobOwnership(req, res, jobId))) return;
      if (!(await assertCandidateOwnership(req, res, candidateId))) return;

      const record = await getIntelligenceForPair(
        jobId,
        candidateId,
        await getDataScopeTenantIds(req.resolvedUser!),
      );
      if (!record) return res.status(404).json({ error: "No intelligence record found" });

      const scores = {
        fitScore: record.fitScore ?? 50,
        qualityScore: record.qualityScore ?? 50,
        trustScore: record.trustScore ?? 50,
        conversionScore: record.conversionScore ?? 50,
        hireProbability: record.hireProbability ?? 50,
      };
      const policy = await getPolicy(record.tenantId);
      const timestamps = (record.signalTimestampsJson as any) ?? {};
      const decisionResult = decideNextAction(
        scores,
        (record.signalsJson as any) ?? {},
        timestamps,
        policy,
      );
      const action = (force ?? decisionResult.decision) as string;

      // Check if approval is required
      if (decisionResult.requiresApproval) {
        return res.json({
          triggered: false,
          action,
          blocked: "approval_required",
          message: "Recruiter approval required by tenant policy before this action can execute.",
          decisionResult,
          workflowAction: "await_approval",
        });
      }

      // Check if auto-trigger is allowed by policy
      const policyBlocksAutoTrigger =
        (action === "advance" && !policy.allowAutoOutreach) ||
        (action === "schedule" && !policy.allowAutoSchedule) ||
        (action === "re_engage" && !policy.allowAutoReengage);

      if (policyBlocksAutoTrigger) {
        return res.json({
          triggered: false,
          action,
          blocked: "policy_disabled_automation",
          message: `Tenant policy has disabled automatic triggering for action "${action}". Recruiter must action manually.`,
          decisionResult,
        });
      }

      const actionToAgent: Record<string, { agentId: string } | null> = {
        advance: { agentId: "outreach" },
        schedule: { agentId: "scheduling" },
        re_engage: { agentId: "anti-ghosting" },
        manual_verification: { agentId: "verification" },
        recruiter_review: null,
        reject: null,
        hold: null,
      };

      const trigger = actionToAgent[action];
      if (!trigger) {
        return res.json({
          triggered: false,
          action,
          message: `Action "${action}" is a manual step and does not trigger an agent automatically.`,
          workflowAction: decisionResult.workflowAction,
          targetStage: decisionResult.targetStage,
          decisionResult,
        });
      }

      const agentRun = await orchestrator.triggerAgent(
        trigger.agentId as any,
        {
          jobId,
          candidateId,
          tenantId: record.tenantId,
          triggeredByIntelligence: true,
          intelligenceAction: action,
          reason: decisionResult.reasoning,
        },
        "intelligence-engine",
      );

      logger.info(
        { action, agentId: trigger.agentId, runId: agentRun.id, jobId, candidateId },
        "Action triggered from intelligence",
      );

      res.json({
        triggered: true,
        action,
        agentId: trigger.agentId,
        runId: agentRun.id,
        status: agentRun.status,
        workflowAction: decisionResult.workflowAction,
        targetStage: decisionResult.targetStage,
        decisionResult,
        message: `Triggered ${trigger.agentId} agent for "${action}" decision.`,
      });
    } catch (err: any) {
      logger.error({ err }, "Failed to trigger action");
      res.status(500).json({ error: err?.message ?? "Failed to trigger action" });
    }
  },
);

/* ── POST /intelligence/:jobId/:candidateId/override ─────────────────────── */
router.post(
  "/:jobId/:candidateId/override",
  validate({ body: OverrideBody }),
  enforceOwnership({ kinds: ["jobId", "candidateId"] }),
  async (req, res) => {
    try {
      const { jobId, candidateId } = req.params;
      if (!(await assertJobOwnership(req, res, jobId))) return;
      if (!(await assertCandidateOwnership(req, res, candidateId))) return;
      const { originalDecision, recruiterDecision, recruiterReason, recruiterId } = req.body as {
        originalDecision?: string;
        recruiterDecision?: string;
        recruiterReason?: string;
        recruiterId?: string;
      };

      if (!originalDecision || !VALID_ACTIONS.includes(originalDecision as any)) {
        return res
          .status(400)
          .json({ error: `originalDecision must be one of: ${VALID_ACTIONS.join(", ")}` });
      }
      if (!recruiterDecision || !VALID_ACTIONS.includes(recruiterDecision as any)) {
        return res
          .status(400)
          .json({ error: `recruiterDecision must be one of: ${VALID_ACTIONS.join(", ")}` });
      }
      if (!recruiterReason || recruiterReason.trim().length < 3) {
        return res.status(400).json({ error: "recruiterReason is required (min 3 chars)" });
      }

      await recordOverride(
        jobId,
        candidateId,
        originalDecision as any,
        recruiterDecision as any,
        recruiterReason,
        recruiterId,
      );

      res.json({
        success: true,
        override: {
          originalDecision,
          recruiterDecision,
          recruiterReason,
          recruiterId,
          overriddenAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Failed to record override");
      res.status(500).json({ error: err?.message ?? "Failed to record override" });
    }
  },
);

/* ── POST /:jobId/:candidateId/feedback ──────────────────────────────────── */
router.post(
  "/:jobId/:candidateId/feedback",
  validate({ body: FeedbackBody }),
  enforceOwnership({ kinds: ["jobId", "candidateId"] }),
  async (req, res) => {
    try {
      if (!(await assertJobOwnership(req, res, req.params.jobId))) return;
      if (!(await assertCandidateOwnership(req, res, req.params.candidateId))) return;
      const { rating } = req.body as { rating?: string };
      if (!rating || !["positive", "negative"].includes(rating)) {
        return res.status(400).json({ error: "rating must be 'positive' or 'negative'" });
      }

      const allowedTenantIds = await getDataScopeTenantIds(req.resolvedUser!);
      const [row] = await db
        .select({ overridesJson: candidateJobIntelligenceTable.overridesJson })
        .from(candidateJobIntelligenceTable)
        .where(
          and(
            eq(candidateJobIntelligenceTable.jobId, req.params.jobId),
            eq(candidateJobIntelligenceTable.candidateId, req.params.candidateId),
            cjiTenantScope(allowedTenantIds),
          ),
        );

      if (!row) {
        return res.status(404).json({ error: "Intelligence record not found" });
      }

      const overrides: any[] = JSON.parse(row.overridesJson ?? "[]");
      overrides.push({
        id: `fb_${Date.now()}`,
        type: "feedback",
        rating,
        recordedAt: new Date().toISOString(),
      });

      await db
        .update(candidateJobIntelligenceTable)
        .set({ overridesJson: JSON.stringify(overrides) })
        .where(
          and(
            eq(candidateJobIntelligenceTable.jobId, req.params.jobId),
            eq(candidateJobIntelligenceTable.candidateId, req.params.candidateId),
            cjiTenantScope(allowedTenantIds),
          ),
        );

      logger.info(
        { jobId: req.params.jobId, candidateId: req.params.candidateId, rating },
        "Recruiter feedback recorded",
      );
      res.json({ success: true, rating });
    } catch (err: any) {
      logger.error({ err }, "Failed to record feedback");
      res.status(500).json({ error: err?.message ?? "Failed to record feedback" });
    }
  },
);

/* ── PATCH /:jobId/:candidateId/outcome ───────────────────────────────────── */
/* Record the ground-truth hiring outcome for a (job, candidate) pair. This is
   the supervised signal that feeds the learning loop (getLearningInsights). */
router.patch(
  "/:jobId/:candidateId/outcome",
  validate({ body: OutcomeBody }),
  enforceOwnership({ kinds: ["jobId", "candidateId"] }),
  async (req, res) => {
    try {
      if (!(await assertJobOwnership(req, res, req.params.jobId))) return;
      if (!(await assertCandidateOwnership(req, res, req.params.candidateId))) return;
      const { outcome } = req.body as { outcome?: string };

      if (!outcome || !VALID_OUTCOMES.includes(outcome as any)) {
        return res
          .status(400)
          .json({ error: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}` });
      }

      await recordOutcome(
        req.params.jobId,
        req.params.candidateId,
        outcome as (typeof VALID_OUTCOMES)[number],
      );
      /* Learning insights are a PLATFORM-WIDE cross-tenant aggregate (see the
       platform_admin-gated GET /outcomes/learning). A recruiter recording an
       outcome for their own (job, candidate) pair must NOT receive the global
       aggregate back — only the Lexy ops team may. Gate the serving path. */
      const insights =
        req.resolvedUser?.role === "platform_admin" ? await getLearningInsights() : null;

      logger.info(
        { jobId: req.params.jobId, candidateId: req.params.candidateId, outcome },
        "Outcome recorded — learning updated",
      );
      res.json({ success: true, outcome, ...(insights ? { learningInsights: insights } : {}) });
    } catch (err: any) {
      logger.error({ err }, "Failed to record outcome");
      res.status(400).json({ error: err?.message ?? "Failed to record outcome" });
    }
  },
);

export default router;
