/**
 * routes/evaluations.ts — Client-facing Candidate Evaluation API
 *
 * A rich, role-adaptive, HUMAN-DRIVEN evaluation for ONE candidate × ONE role.
 * The AI drafts; the recruiter overrides which competencies appear, edits every
 * section, adds comments, and APPROVES before anything is client-facing. The
 * approved, merged content drives both the in-app report and the client PDF.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /evaluations/:jobId/:candidateId        Fetch (merged) or 204 if none
 *   POST /evaluations/generate                    Draft/create for a pair
 *   PATCH /evaluations/:id                        Save human edits + competency set
 *   POST /evaluations/:id/approve                 Approve (locks as client-facing)
 *   POST /evaluations/:id/reopen                  Re-open an approved report to edit
 *   POST /evaluations/:id/regenerate              Re-run the AI for the current set
 *
 * ─── AuthZ ───────────────────────────────────────────────────────────────────
 * resolveUser (router-level) + STAFF role allowlist + job ownership (tenant
 * subtree, 404 not 403) + candidate ownership + a plain recruiter is ceilinged
 * to their ASSIGNED requisitions. candidate_evaluations is FORCE-RLS; routes ALSO
 * apply the tenant predicate explicitly (dev strips RLS on most tables).
 */
import { Router } from "express";
import { z } from "zod";
import { validate } from "../middlewares/validate";
import { resolveUser } from "../middlewares/resolveUser";
import { db } from "@workspace/db";
import {
  candidateEvaluationsTable,
  candidatesTable,
  jobsTable,
  sourcedCandidatesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import {
  gatherEvaluationInputs,
  synthesizeEvaluation,
  defaultCompetencyKeysFor,
  computeConfidence,
  computeRecommendationBand,
  mergeEvaluation,
  verificationStateFor,
  RECOMMENDATION_BANDS,
  RECOMMENDATION_BAND_LABEL,
  type EvaluationContent,
  type EvaluationHumanEdits,
} from "../lib/evaluation-synthesis";
import { COMPETENCY_LIBRARY } from "../lib/competency-library";

const router = Router();
router.use(resolveUser);

const STAFF_ROLES = [
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
  "interviewer",
];

/* Every evaluation route is staff-only. Candidates carry a tenantId, so the
   tenant scope helpers are NOT a staff gate — this allowlist is. */
router.use((req, res, next) => {
  const user = req.resolvedUser!;
  if (!STAFF_ROLES.includes(user.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
});

/* Subtree-aware tenant gate (null = platform_admin ⇒ all; null tenant row ⇒
   accessible legacy row). */
async function canAccessTenant(
  user: { id: string; role: string; tenantId: string | null },
  tenantId: string | null | undefined,
): Promise<boolean> {
  const allowed = await getDataScopeTenantIds(user);
  if (allowed === null) return true;
  if (!tenantId) return true;
  return allowed.includes(tenantId);
}

/**
 * Authorise a job: it must exist, be in the caller's tenant scope, and — for a
 * plain recruiter — be one of their ASSIGNED requisitions. Returns the job's
 * tenantId on success; sends 404 and returns null otherwise.
 */
async function authorizeJob(req: any, res: any, jobId: string): Promise<string | null> {
  const user = req.resolvedUser!;
  const [job] = await db
    .select({ tenantId: jobsTable.tenantId })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (!(await canAccessTenant(user, job.tenantId))) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (user.role === "recruiter") {
    const assigned = new Set(await getRecruiterAssignedJobIds(user));
    if (!assigned.has(jobId)) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
  }
  return job.tenantId ?? null;
}

/** Confirm the candidate exists and is in the caller's tenant scope. */
async function authorizeCandidate(req: any, res: any, candidateId: string): Promise<boolean> {
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

/* Serialise a row into the API shape: the row + the MERGED client-facing content.
   Verification is overlaid LIVE from the candidate row — the snapshot stamped at
   generation time goes stale the moment verification (re-)runs or completes. */
async function serialize(row: typeof candidateEvaluationsTable.$inferSelect) {
  const merged = mergeEvaluation(
    row.aiContent as EvaluationContent,
    (row.humanEdits as EvaluationHumanEdits) ?? null,
    row.competencyKeys ?? [],
  );
  try {
    const [c] = await db
      .select({
        verificationStatus: candidatesTable.verificationStatus,
        verificationResult: candidatesTable.verificationResult,
      })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, row.candidateId))
      .limit(1);
    if (c) merged.verification = verificationStateFor(c);
  } catch (err) {
    logger.warn(
      { err, evaluationId: row.id },
      "live verification overlay failed — serving stored snapshot",
    );
  }
  return {
    id: row.id,
    jobId: row.jobId,
    candidateId: row.candidateId,
    competencyKeys: row.competencyKeys ?? [],
    recommendationBand: row.recommendationBand,
    confidence: row.confidence,
    approvalState: row.approvalState,
    model: row.model,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    content: merged,
    aiContent: row.aiContent,
    humanEdits: row.humanEdits ?? null,
  };
}

/* The competency library + band labels — so the FE picker and PDF share one
   source of truth without hard-coding. */
router.get("/library", (_req, res) => {
  res.json({
    competencies: Object.values(COMPETENCY_LIBRARY),
    bands: RECOMMENDATION_BANDS.map((b) => ({ value: b, label: RECOMMENDATION_BAND_LABEL[b] })),
  });
});

/* ── GET /evaluations/:jobId/:candidateId ─────────────────────────────────── */
router.get("/:jobId/:candidateId", async (req, res) => {
  try {
    const { jobId, candidateId } = req.params;
    const tenantId = await authorizeJob(req, res, jobId);
    if (tenantId === null && res.headersSent) return;
    if (!(await authorizeCandidate(req, res, candidateId))) return;

    const [row] = await db
      .select()
      .from(candidateEvaluationsTable)
      .where(
        and(
          eq(candidateEvaluationsTable.jobId, jobId),
          eq(candidateEvaluationsTable.candidateId, candidateId),
        ),
      )
      .limit(1);

    if (!row) {
      // No evaluation yet — return the default competency set so the UI can
      // offer a pre-filled Generate.
      const scope = await getDataScopeTenantIds(req.resolvedUser!);
      const inputs = await gatherEvaluationInputs(jobId, candidateId, scope);
      const defaultKeys = inputs ? defaultCompetencyKeysFor(inputs) : [];
      res.json({ evaluation: null, defaultCompetencyKeys: defaultKeys });
      return;
    }
    if (!(await canAccessTenant(req.resolvedUser!, row.tenantId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ evaluation: await serialize(row) });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch evaluation");
    res.status(500).json({ error: "Failed to fetch evaluation" });
  }
});

const GenerateBody = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  competencyKeys: z.array(z.string()).optional(),
});

/* ── POST /evaluations/generate ───────────────────────────────────────────── */
router.post("/generate", validate({ body: GenerateBody }), async (req, res) => {
  try {
    const user = req.resolvedUser!;
    const { jobId, candidateId, competencyKeys } = req.body as z.infer<typeof GenerateBody>;
    const tenantId = await authorizeJob(req, res, jobId);
    if (tenantId === null) return; // 404 already sent
    if (!(await authorizeCandidate(req, res, candidateId))) return;

    const scope = await getDataScopeTenantIds(user);
    const inputs = await gatherEvaluationInputs(jobId, candidateId, scope);
    if (!inputs) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Recruiter-chosen set wins; else the role-adaptive default. Only known keys.
    const requested = (
      competencyKeys?.length ? competencyKeys : defaultCompetencyKeysFor(inputs)
    ).filter((k) => COMPETENCY_LIBRARY[k]);
    const keys = requested.length ? requested : defaultCompetencyKeysFor(inputs);

    const { content, model } = await synthesizeEvaluation(inputs, keys);
    const band = computeRecommendationBand(inputs);
    const confidence = computeConfidence(inputs, content.competencies);

    // Upsert (regenerate overwrites the AI draft but PRESERVES human edits +
    // approval is reset to draft since the underlying draft changed).
    const [existing] = await db
      .select()
      .from(candidateEvaluationsTable)
      .where(
        and(
          eq(candidateEvaluationsTable.jobId, jobId),
          eq(candidateEvaluationsTable.candidateId, candidateId),
        ),
      )
      .limit(1);

    let row;
    if (existing) {
      [row] = await db
        .update(candidateEvaluationsTable)
        .set({
          aiContent: content,
          competencyKeys: keys,
          recommendationBand: band,
          confidence,
          model,
          approvalState: "draft",
          approvedByUserId: null,
          approvedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(candidateEvaluationsTable.id, existing.id))
        .returning();
    } else {
      [row] = await db
        .insert(candidateEvaluationsTable)
        .values({
          tenantId: tenantId!,
          jobId,
          candidateId,
          aiContent: content,
          competencyKeys: keys,
          recommendationBand: band,
          confidence,
          model,
          generatedByUserId: user.id,
          approvalState: "draft",
        })
        .returning();
    }
    res.json({ evaluation: await serialize(row!) });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate evaluation");
    res.status(500).json({ error: "Failed to generate evaluation" });
  }
});

/* Load a row by id, authorised. Returns the row or null (response already sent). */
async function loadAuthorized(req: any, res: any, id: string) {
  const [row] = await db
    .select()
    .from(candidateEvaluationsTable)
    .where(eq(candidateEvaluationsTable.id, id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (!(await canAccessTenant(req.resolvedUser!, row.tenantId))) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  // Recruiter req-assignment ceiling.
  if (req.resolvedUser!.role === "recruiter") {
    const assigned = new Set(await getRecruiterAssignedJobIds(req.resolvedUser!));
    if (!assigned.has(row.jobId)) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
  }
  return row;
}

const PatchBody = z.object({
  humanEdits: z.record(z.unknown()).optional(),
  competencyKeys: z.array(z.string()).optional(),
});

/* ── PATCH /evaluations/:id ────────────────────────────────────────────────── */
router.patch("/:id", validate({ body: PatchBody }), async (req, res) => {
  try {
    const row = await loadAuthorized(req, res, req.params.id);
    if (!row) return;
    const { humanEdits, competencyKeys } = req.body as z.infer<typeof PatchBody>;

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (humanEdits !== undefined) set.humanEdits = humanEdits;
    if (competencyKeys !== undefined)
      set.competencyKeys = competencyKeys.filter((k) => COMPETENCY_LIBRARY[k]);

    // TOCTOU-safe: only mutate a row that is still a draft (editing an approved
    // report requires an explicit reopen first).
    const [updated] = await db
      .update(candidateEvaluationsTable)
      .set(set)
      .where(
        and(
          eq(candidateEvaluationsTable.id, row.id),
          eq(candidateEvaluationsTable.approvalState, "draft"),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Evaluation is approved — reopen it before editing." });
      return;
    }
    res.json({ evaluation: await serialize(updated) });
  } catch (err: any) {
    logger.error({ err }, "Failed to update evaluation");
    res.status(500).json({ error: "Failed to update evaluation" });
  }
});

/* ── POST /evaluations/:id/approve ─────────────────────────────────────────── */
router.post("/:id/approve", async (req, res) => {
  try {
    const row = await loadAuthorized(req, res, req.params.id);
    if (!row) return;
    const [updated] = await db
      .update(candidateEvaluationsTable)
      .set({
        approvalState: "approved",
        approvedByUserId: req.resolvedUser!.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(candidateEvaluationsTable.id, row.id),
          eq(candidateEvaluationsTable.approvalState, "draft"),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({ error: "Already approved." });
      return;
    }
    res.json({ evaluation: await serialize(updated) });
  } catch (err: any) {
    logger.error({ err }, "Failed to approve evaluation");
    res.status(500).json({ error: "Failed to approve evaluation" });
  }
});

/* ── POST /evaluations/:id/reopen ──────────────────────────────────────────── */
router.post("/:id/reopen", async (req, res) => {
  try {
    const row = await loadAuthorized(req, res, req.params.id);
    if (!row) return;
    const [updated] = await db
      .update(candidateEvaluationsTable)
      .set({
        approvalState: "draft",
        approvedByUserId: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(candidateEvaluationsTable.id, row.id))
      .returning();
    res.json({ evaluation: await serialize(updated!) });
  } catch (err: any) {
    logger.error({ err }, "Failed to reopen evaluation");
    res.status(500).json({ error: "Failed to reopen evaluation" });
  }
});

const RegenerateBody = z.object({ competencyKeys: z.array(z.string()).optional() });

/* ── POST /evaluations/:id/regenerate ──────────────────────────────────────── */
router.post("/:id/regenerate", validate({ body: RegenerateBody }), async (req, res) => {
  try {
    const row = await loadAuthorized(req, res, req.params.id);
    if (!row) return;
    const { competencyKeys } = req.body as z.infer<typeof RegenerateBody>;

    const scope = await getDataScopeTenantIds(req.resolvedUser!);
    const inputs = await gatherEvaluationInputs(row.jobId, row.candidateId, scope);
    if (!inputs) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const requested = (competencyKeys?.length ? competencyKeys : (row.competencyKeys ?? [])).filter(
      (k) => COMPETENCY_LIBRARY[k],
    );
    const keys = requested.length ? requested : defaultCompetencyKeysFor(inputs);

    const { content, model } = await synthesizeEvaluation(inputs, keys);
    const band = computeRecommendationBand(inputs);
    const confidence = computeConfidence(inputs, content.competencies);

    // Regenerating rewrites the AI draft → reset to draft, preserve human edits.
    const [updated] = await db
      .update(candidateEvaluationsTable)
      .set({
        aiContent: content,
        competencyKeys: keys,
        recommendationBand: band,
        confidence,
        model,
        approvalState: "draft",
        approvedByUserId: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(candidateEvaluationsTable.id, row.id))
      .returning();
    res.json({ evaluation: await serialize(updated!) });
  } catch (err: any) {
    logger.error({ err }, "Failed to regenerate evaluation");
    res.status(500).json({ error: "Failed to regenerate evaluation" });
  }
});

export default router;
