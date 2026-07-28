/**
 * routes/pipeline.ts — Job Pipeline Canvas, Sourced Candidate Board & Run Orchestration
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Powers the recruiter-facing pipeline canvas: a Kanban-style board where
 * sourced candidates are dragged through stages, agents are configured, and
 * pipeline runs are launched. Also handles the sourced-candidates detail views
 * used by the "People" tab alongside each pipeline.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET    /jobs/:jobId/pipeline                 Fetch (or auto-create) the pipeline
 *                                                config + last 5 runs + outreach msgs
 *   PUT    /jobs/:jobId/pipeline                 Update agent list / autoRun toggle
 *   POST   /jobs/:jobId/pipeline/run             Start a full pipeline run (202 async)
 *   GET    /jobs/:jobId/pipeline/runs            List all pipeline runs for a job
 *   GET    /jobs/:jobId/pipeline/runs/:runId     Get a single run + stage statuses
 *   GET    /jobs/:jobId/sourced-candidates       List sourced candidates (Kanban rows)
 *   POST   /jobs/:jobId/sourced-candidates       Manually add a sourced candidate
 *   PATCH  /jobs/:jobId/sourced-candidates/:id   Advance stage (drag → drop)
 *   DELETE /jobs/:jobId/sourced-candidates/:id   Remove from sourced pool
 *   POST   /jobs/:jobId/sourced-candidates/:id/send-invite  Send interview invite
 *   POST   /jobs/:jobId/sourced-candidates/:id/reject       Reject + send email
 *   GET    /jobs/:jobId/outreach-messages        Messages sent by the Outreach agent
 *   GET    /pipeline-stats                       Platform-wide funnel metrics
 *
 * ─── Default pipeline config ─────────────────────────────────────────────────
 * On first GET /jobs/:id/pipeline the route auto-creates a pipeline with
 * DEFAULT_PIPELINE_AGENTS — a 10-agent config matching the canonical hiring
 * funnel order (ICP → sourcing → screening → verification → outreach →
 * interview → scheduling → anti-ghosting → proctoring → analytics).
 *
 * ─── Stage advance rules ─────────────────────────────────────────────────────
 * PATCH /sourced-candidates/:id validates the target stage against
 * VALID_STAGES before writing. Moving a candidate to "interview_scheduled"
 * triggers interview-reply.ts to issue an invite link. Moving to "rejected"
 * calls recordRejection() which handles the rejection email + audit row.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { controlDb, db } from "@workspace/db";
import { jobPipelinesTable, outreachMessagesTable, pipelineRunsTable, jobsTable, applicationsTable, candidatesTable, sourcedCandidatesTable, interviewPlansTable, interviewSessionsTable, usersTable, tenantsTable, userNotificationsTable } from "@workspace/db";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { orchestrator } from "../lib/agents/orchestrator";
import { getIntelligenceForJob } from "../lib/intelligence";
import { runVerificationAgent } from "../lib/run-verification.js";
import { getAuthUserId } from "../lib/auth-token";
import { getAllowedTenantIds, getDataScopeTenantIds } from "../lib/tenantUtils";
import { computeCandidateMerge } from "../lib/candidate-merge";
import { deriveSourcedStage } from "../lib/sourced-stage.js";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";
import { validate } from "../middlewares/validate";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";
import { DEFAULT_PIPELINE_AGENTS } from "../lib/pipeline-defaults.js";

const UpdatePipelineBody = z.object({
  agents: z.array(z.record(z.unknown())).optional(),
  autoRun: z.boolean().optional(),
}).passthrough();

const RunPipelineBody = z.object({
  triggeredBy: z.string().optional(),
}).passthrough();

const AddCandidateBody = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  currentTitle: z.string().optional().nullable(),
  currentCompany: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  skills: z.union([z.array(z.string()), z.string()]).optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  githubUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // When true, an email collision updates the existing candidate (merging the
  // newer info) and links them to this job instead of returning a 409.
  mergeIntoExisting: z.boolean().optional(),
}).passthrough();

const CardActionBody = z.object({
  action: z.string().min(1),
  sourcedId: z.string().optional().nullable(),
  applicationId: z.string().optional().nullable(),
  sentiment: z.enum(["positive", "negative", "do_not_contact"]).optional(),
  replyBody: z.string().optional().nullable(),
  reason: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
}).passthrough();

const router: IRouter = Router();

/* ─── Auth + tenant gate (used by every job-scoped route below) ────────────
   Anonymous callers were previously able to hit every route in this file
   and read/mutate other tenants' pipelines. This helper requires an
   authenticated caller AND ensures the URL :jobId belongs to one of the
   tenants the caller can see. Returns the user+job on success, sends a
   401/404 and returns null on failure. */
async function gateJobAccess(req: any, res: any, jobId: string): Promise<{ user: any; job: any } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) { res.status(404).json({ error: "Not found" }); return null; }
  if (user.role !== "platform_admin") {
    // DATA-scope ceiling (not the raw subtree): recruiter_admin is narrowed to
    // ONLY their assigned client sub-tenants ([] ⇒ nothing); every other role
    // gets the full descendant subtree, matching the RLS policy.
    const allowed = (await getDataScopeTenantIds(user)) ?? [];
    if (!allowed.includes(job.tenantId ?? "")) {
      res.status(404).json({ error: "Not found" }); return null;
    }
  }
  return { user, job };
}

/* GET /jobs/:jobId/pipeline */
router.get("/jobs/:jobId/pipeline", async (req, res) => {
  const { jobId } = req.params;
  const gate = await gateJobAccess(req, res, jobId);
  if (!gate) return;
  let [pipeline] = await db.select().from(jobPipelinesTable).where(eq(jobPipelinesTable.jobId, jobId)).limit(1);

  if (!pipeline) {
    [pipeline] = await db.insert(jobPipelinesTable).values({
      jobId,
      tenantId: gate.job.tenantId,
      agents: DEFAULT_PIPELINE_AGENTS,
      autoRun: false,
      status: "idle",
    }).returning();
  }

  const runs = await db.select().from(pipelineRunsTable)
    .where(eq(pipelineRunsTable.jobId, jobId))
    .orderBy(desc(pipelineRunsTable.startedAt))
    .limit(5);

  const messages = await db.select().from(outreachMessagesTable)
    .where(eq(outreachMessagesTable.jobId, jobId))
    .orderBy(desc(outreachMessagesTable.createdAt))
    .limit(50);

  res.json({
    ...pipeline,
    lastRunAt: pipeline.lastRunAt?.toISOString() ?? null,
    createdAt: pipeline.createdAt.toISOString(),
    updatedAt: pipeline.updatedAt.toISOString(),
    recentRuns: runs.map(r => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    outreachMessages: messages.map(m => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
      repliedAt: m.repliedAt?.toISOString() ?? null,
    })),
  });
});

/* PUT /jobs/:jobId/pipeline */
router.put("/jobs/:jobId/pipeline", validate({ body: UpdatePipelineBody }), async (req, res) => {
  const { jobId } = req.params;
  const gate = await gateJobAccess(req, res, jobId);
  if (!gate) return;
  const { agents, autoRun } = req.body;

  const existing = await db.select().from(jobPipelinesTable).where(eq(jobPipelinesTable.jobId, jobId)).limit(1);
  let pipeline;

  if (existing.length === 0) {
    [pipeline] = await db.insert(jobPipelinesTable).values({ jobId, tenantId: gate.job.tenantId, agents: agents ?? DEFAULT_PIPELINE_AGENTS, autoRun: autoRun ?? false }).returning();
  } else {
    const updates: any = { updatedAt: new Date() };
    if (agents !== undefined) updates.agents = agents;
    if (autoRun !== undefined) updates.autoRun = autoRun;
    [pipeline] = await db.update(jobPipelinesTable).set(updates).where(eq(jobPipelinesTable.jobId, jobId)).returning();
  }

  res.json({ ...pipeline, updatedAt: pipeline.updatedAt.toISOString(), createdAt: pipeline.createdAt.toISOString() });
});

/* POST /jobs/:jobId/pipeline/run */
router.post("/jobs/:jobId/pipeline/run", validate({ body: RunPipelineBody }), async (req, res) => {
  const { jobId } = req.params;
  if (!(await gateJobAccess(req, res, jobId))) return;
  const { triggeredBy = "user" } = req.body;

  const [pipeline] = await db.select().from(jobPipelinesTable).where(eq(jobPipelinesTable.jobId, jobId)).limit(1);
  if (!pipeline) { res.status(404).json({ error: "Pipeline not configured for this job" }); return; }

  const enabledAgents = (pipeline.agents as any[]).filter(a => a.enabled).sort((a, b) => a.order - b.order);
  if (enabledAgents.length === 0) { res.status(400).json({ error: "No agents enabled in pipeline" }); return; }

  const [run] = await db.insert(pipelineRunsTable).values({
    jobId,
    tenantId: pipeline.tenantId,
    triggeredBy,
    /* Durable forensic "who": the canvas / workflow-board trigger goes through
       this route, so stamp the authenticated caller's id (the coarse
       `triggeredBy` label is not a user id). Null only for unauthenticated
       system paths. Mirrors the Agent Dashboard trigger in agents.ts. */
    triggeredByUserId: getAuthUserId(req),
    status: "running",
    stages: enabledAgents.map(a => ({ agentId: a.id, status: "pending", startedAt: null, completedAt: null, output: null })),
  }).returning();

  await db.update(jobPipelinesTable).set({ status: "running", currentStage: enabledAgents[0].id, lastRunAt: new Date(), updatedAt: new Date() }).where(eq(jobPipelinesTable.jobId, jobId));

  res.status(202).json({
    runId: run.id,
    jobId,
    stages: enabledAgents.map(a => a.id),
    message: `Pipeline started — running ${enabledAgents.length} agents`,
  });

  setImmediate(async () => {
    try {
      await orchestrator.runPipeline(jobId, run.id, enabledAgents, triggeredBy);
      await db.update(jobPipelinesTable).set({ status: "idle", currentStage: null, updatedAt: new Date() }).where(eq(jobPipelinesTable.jobId, jobId));
      await db.update(pipelineRunsTable).set({ status: "completed", completedAt: new Date() }).where(eq(pipelineRunsTable.id, run.id));
    } catch (err: any) {
      await db.update(jobPipelinesTable).set({ status: "idle", currentStage: null, updatedAt: new Date() }).where(eq(jobPipelinesTable.jobId, jobId));
      await db.update(pipelineRunsTable).set({ status: "failed", completedAt: new Date(), error: err?.message }).where(eq(pipelineRunsTable.id, run.id));
    }
  });
});

/* GET /jobs/:jobId/pipeline/runs */
router.get("/jobs/:jobId/pipeline/runs", async (req, res) => {
  if (!(await gateJobAccess(req, res, req.params.jobId))) return;
  const runs = await db.select().from(pipelineRunsTable)
    .where(eq(pipelineRunsTable.jobId, req.params.jobId))
    .orderBy(desc(pipelineRunsTable.startedAt))
    .limit(20);
  res.json(runs.map(r => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  })));
});

/* GET /jobs/:jobId/pipeline/messages */
router.get("/jobs/:jobId/pipeline/messages", async (req, res) => {
  if (!(await gateJobAccess(req, res, req.params.jobId))) return;
  const messages = await db.select().from(outreachMessagesTable)
    .where(eq(outreachMessagesTable.jobId, req.params.jobId))
    .orderBy(desc(outreachMessagesTable.createdAt));
  res.json(messages.map(m => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
    repliedAt: m.repliedAt?.toISOString() ?? null,
  })));
});

/* A candidate who was REMOVED from the Do-Not-Contact list should disappear
 * from the pipeline board entirely (recruiter's explicit request) — not bounce
 * back into the Rejected column. Marking DNC sets stage=rejected AND hides them;
 * clearing DNC must therefore keep them hidden rather than un-hiding a rejected
 * card. We detect this from the data already written by DELETE /api/dnc/:id,
 * which is the ONLY writer that sets dnc_reason to a "Removed: …" prefix while
 * flipping do_not_contact back to false. No schema change required. */
function wasRemovedFromDnc(c: { doNotContact?: boolean | null; dncReason?: string | null } | null | undefined): boolean {
  if (!c) return false;
  return c.doNotContact === false
    && typeof c.dncReason === "string"
    && c.dncReason.startsWith("Removed:");
}

/* Synthetic placeholder emails minted for candidates with no real address
 * (manual add, CSV/CV import) all live on the @unknown.local domain. They are
 * unique per row, so they must NOT be used as a shared identity — otherwise two
 * unrelated no-email candidates would never collide (harmless) but, worse, a
 * real email could be shadowed. We simply treat them as "no email". */
function isRealEmail(email: string): boolean {
  return !!email && !email.endsWith("@unknown.local");
}

/* Stable identity for de-duplication across sourced + application rows.
 * Prefer a REAL email (the same person sourced twice, or sourced + applied,
 * collapses to one card). Fall back to the normalized candidate id, then a
 * per-row id so distinct no-email candidates never merge. */
function pipelineIdentityKey(row: { candidate?: { email?: string | null; id?: string | null } | null; sourcedId?: string | null; applicationId?: string | null }): string {
  const email = row.candidate?.email?.trim()?.toLowerCase() ?? "";
  if (isRealEmail(email)) return `e:${email}`;
  const cid = row.candidate?.id;
  if (cid) return `c:${cid}`;
  return `r:${row.applicationId ?? row.sourcedId ?? Math.random()}`;
}

/* GET /jobs/:jobId/pipeline-stages — Kanban stage data for the Pipeline tab */
router.get("/jobs/:jobId/pipeline-stages", async (req, res) => {
  const { jobId } = req.params;
  const gate = await gateJobAccess(req, res, jobId);
  if (!gate) return;
  const { job } = gate;

  // All applications for this job, joined with candidate
  const apps = await db.select().from(applicationsTable)
    .where(eq(applicationsTable.jobId, jobId))
    .orderBy(desc(applicationsTable.updatedAt));

  const withCandidates = await Promise.all(apps.map(async (a) => {
    const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, a.candidateId)).limit(1);
    // Orphaned application: the candidate record no longer exists (deleted or
    // erased out of band). Without this guard the card renders as a nameless
    // "?" ghost — drop it from the board entirely.
    if (!c) return null;
    if (c && (c as any).dataErasedAt) return null;
    // DNC candidates fall out of the pipeline entirely — they should
    // never appear on the kanban regardless of stage.
    if (c && (c as any).doNotContact === true) return null;
    // Candidates removed from the DNC list stay off the board too.
    if (wasRemovedFromDnc(c as any)) return null;

    /* For application-based candidates, look up the most recent completed
     * interview session so the card can render a "Watch Recording" link
     * once the candidate reaches the interview_completed / hm_review stage. */
    let latestInterviewSessionId: string | null = null;
    if (c?.id && (a.stage === "interview_completed" || a.stage === "hm_review" || a.stage === "offer")) {
      const [latest] = await db.select({ id: interviewSessionsTable.id })
        .from(interviewSessionsTable)
        .where(and(eq(interviewSessionsTable.candidateId, c.id), eq(interviewSessionsTable.status, "completed")))
        .orderBy(desc(interviewSessionsTable.completedAt))
        .limit(1);
      latestInterviewSessionId = latest?.id ?? null;
    }

    return {
      applicationId: a.id,
      stage: a.stage || "applied",
      score: a.matchScore ?? c?.resumeScreenScore ?? null,
      nba: a.nextBestAction ?? null,
      notes: a.notes ?? null,
      updatedAt: a.updatedAt.toISOString(),
      createdAt: a.createdAt.toISOString(),
      verificationResult: (c as any)?.verificationResult ?? null,
      verificationStatus: c?.verificationStatus ?? null,
      /* Surface a placeholder/missing real email so the board can flag that this
       * candidate cannot be messaged until a recruiter adds an address. */
      missingEmail: !isRealEmail(typeof c?.email === "string" ? c.email : ""),
      candidate: c ? {
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email: typeof c.email === "string" ? c.email.toLowerCase() : c.email,
        currentTitle: c.currentTitle ?? null,
        currentCompany: c.currentCompany ?? null,
        location: c.location ?? null,
        source: c.source ?? null,
        skills: c.skills ?? [],
        linkedinUrl: c.linkedinUrl ?? null,
        githubProfile: c.githubProfile ?? null,
        resumeScreenScore: c.resumeScreenScore ?? null,
        verificationStatus: c.verificationStatus ?? null,
        interviewSessionId: latestInterviewSessionId,
      } : null,
    };
  }));

  // Also grab sourced candidates not yet in applications — SCOPED to the job's
  // tenant. Previously this pulled the 50 most-recent sourced rows across ALL
  // tenants and, via the `!raw?.jobId` unattributed clause below, surfaced other
  // tenants' leads on this board — a cross-tenant leak (sourced_candidates is not
  // RLS-enforced in this environment). Scoping to job.tenantId contains it while
  // preserving the same-tenant unattributed-lead behaviour.
  const sourced = await db.select().from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.tenantId, job.tenantId))
    .orderBy(desc(sourcedCandidatesTable.createdAt))
    .limit(50);

  const sourcedWithJobId = sourced.filter(s => {
    const raw = s.rawData as any;
    return raw?.jobId === jobId || !raw?.jobId; // include unattributed sourced candidates
  });

  /* Canonical verification map. A sourced row caches the Verification Agent
   * verdict in its rawData, but a candidate can later be RE-verified through
   * the normalized-candidate path (runCandidateVerification), which updates the
   * candidates row but NOT the sourced rawData. To avoid showing a stale verdict
   * on the Verify card, prefer the canonical candidate's verification whenever
   * the sourced row is linked to a normalized candidate. */
  const normalizedIds = Array.from(new Set(
    sourcedWithJobId.map(s => s.normalizedCandidateId).filter(Boolean) as string[],
  ));
  const canonicalVerification = new Map<string, { verificationResult: any; verificationStatus: string | null }>();
  if (normalizedIds.length > 0) {
    const canon = await db.select({
      id: candidatesTable.id,
      verificationResult: candidatesTable.verificationResult,
      verificationStatus: candidatesTable.verificationStatus,
    }).from(candidatesTable).where(inArray(candidatesTable.id, normalizedIds));
    for (const cc of canon) {
      canonicalVerification.set(cc.id, {
        verificationResult: (cc as any).verificationResult ?? null,
        verificationStatus: cc.verificationStatus ?? null,
      });
    }
  }

  const sourcedRows = sourcedWithJobId.map(s => {
    const raw = s.rawData as any;
    // Prefer the canonical candidate verdict (freshest); fall back to rawData.
    const canonical = s.normalizedCandidateId ? canonicalVerification.get(s.normalizedCandidateId) : undefined;
    const verificationResult = canonical?.verificationResult ?? raw?.verificationResult ?? null;
    const verificationStatus = canonical?.verificationStatus ?? raw?.verificationStatus ?? null;
    const screeningResult = raw?.screeningResult;
    const screened = raw?.screened === true;

    // Stage precedence lives in ONE place — deriveSourcedStage(): stored stage
    // (an attributed, recorded move) wins; otherwise fall back to the screening
    // signal (reject → "rejected", advance/hold → "screening"); default "sourced".
    // Rejected candidates drop out; advance AND hold both surface in the Screening
    // column so recruiters can review AI assessments — "hold" is not invisible.
    const stage = deriveSourcedStage(raw);

    // Best score: prefer screening score over raw match score
    const score = screened && screeningResult?.score != null
      ? screeningResult.score
      : (raw?.matchScore ?? null);

    return {
      applicationId: null,
      stage,
      score,
      nba: screened && screeningResult ? (screeningResult.recommendation === "advance" ? "advance" : screeningResult.recommendation === "reject" ? "reject" : "hold") : null,
      notes: screened && screeningResult?.recruiterSummary ? screeningResult.recruiterSummary : null,
      updatedAt: s.createdAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
      sourcedId: s.id,
      screened,
      screeningResult: screeningResult || null,
      verificationResult,
      verificationStatus,
      missingEmail: !isRealEmail(typeof raw?.email === "string" ? raw.email : ""),
      candidate: {
        id: s.normalizedCandidateId || s.id,
        firstName: raw?.firstName || "Unknown",
        lastName: raw?.lastName || "",
        email: typeof raw?.email === "string" ? raw.email.toLowerCase() : (raw?.email || null),
        phone: raw?.phone || null,
        currentTitle: raw?.currentTitle || null,
        currentCompany: raw?.currentCompany || null,
        location: raw?.location || null,
        source: s.source,
        skills: (raw?.skills?.length ? raw.skills : (screeningResult?.extractedSkills || [])),
        linkedinUrl: raw?.linkedinUrl || null,
        githubProfile: raw?.githubProfile || null,
        resumeScreenScore: score,
        verificationStatus,
        interviewSessionId: raw?.interviewSessionId || null,
      },
    };
  });

  const filteredApps = withCandidates.filter((a): a is NonNullable<typeof a> => a !== null);

  // Build sets of erased / DNC candidate IDs so we can drop sourced rows
  // whose normalized candidate is either erased or has been opted out
  // of contact. DNC candidates should never appear on the kanban.
  const sourcedCandIds = Array.from(new Set(
    sourcedRows.map(s => s.candidate?.id).filter(Boolean) as string[]
  ));
  const erasedIds = new Set<string>();
  const dncIds = new Set<string>();
  const removedIds = new Set<string>();
  if (sourcedCandIds.length > 0) {
    const rows = await db.select({
      id: candidatesTable.id,
      dataErasedAt: candidatesTable.dataErasedAt,
      doNotContact: (candidatesTable as any).doNotContact,
      dncReason: (candidatesTable as any).dncReason,
    })
      .from(candidatesTable)
      .where(inArray(candidatesTable.id, sourcedCandIds));
    for (const r of rows) {
      if ((r as any).dataErasedAt) erasedIds.add(r.id);
      if ((r as any).doNotContact === true) dncIds.add(r.id);
      if (wasRemovedFromDnc(r as any)) removedIds.add(r.id);
    }
  }
  // Pre-index original sourced rows by id so we can cheaply look up
  // raw_data.doNotContact without an O(n²) scan inside the filter.
  const sourcedById = new Map(sourced.map(o => [o.id, o]));
  const filteredSourced = sourcedRows.filter(s => {
    const cid = s.candidate?.id ?? "";
    if (erasedIds.has(cid) || dncIds.has(cid) || removedIds.has(cid)) return false;
    // Also honour the per-sourced-row DNC flag that quick-reply writes
    // to raw_data.doNotContact even when no normalized candidate row
    // exists yet (e.g. unmerged sourced candidates).
    const rawDnc = (sourcedById.get(s.sourcedId)?.rawData as any)?.doNotContact === true;
    return !rawDnc;
  });

  // Merge + de-duplicate. Applications are listed first so they win over a
  // sourced row for the same person (the application is the authoritative
  // pipeline record). We then collapse by a stable identity key — primarily
  // email — so the same candidate never shows twice, whether they were sourced
  // multiple times or both sourced and applied. Unmerged sourced rows (no
  // normalized candidate, no email) keep a unique key and are never merged.
  const mergedRows = [...filteredApps, ...filteredSourced];
  const seenIdentities = new Set<string>();
  const allRows = mergedRows.filter((row) => {
    const key = pipelineIdentityKey(row);
    if (seenIdentities.has(key)) return false;
    seenIdentities.add(key);
    return true;
  });

  /* Score resolver — the accrued candidate_job_intelligence record is the
   * source of truth whenever one exists. Point-in-time scores (application
   * match_score, resume_screen_score, sourced rawData.matchScore) are only a
   * fallback for candidates the intelligence engine hasn't analysed yet. This
   * keeps the board's "Match" pill consistent with the candidate detail card
   * (which renders the same accrued fitScore) and the next-best-action chip
   * consistent with the engine's recommendation. Keyed by candidateId, which
   * for sourced rows is the normalized candidate id (canonical). */
  const intelRows = await getIntelligenceForJob(jobId, await getDataScopeTenantIds(gate.user));
  const intelByCandidate = new Map(intelRows.map(r => [r.candidateId, r]));
  for (const row of allRows) {
    const rec = intelByCandidate.get(row.candidate?.id ?? "");
    if (!rec) continue;
    if (rec.fitScore != null) row.score = rec.fitScore;
    if (rec.nextBestAction) (row as any).nba = rec.nextBestAction;
  }

  // Group by stage
  // grouped[] only allocates buckets for stages listed here; a row whose stage
  // is missing falls back to "applied" and disappears from every rendered lane.
  // So every reachable stage MUST be listed — including the terminal states
  // (hired, started, rejected, offer_declined, withdrawn) which no longer render
  // as board columns but are surfaced by the client's Closed drawer, and the
  // offer sub-stages. Keep this in sync with the client's canonical STAGE_COLS.
  const STAGES = ["sourced", "applied", "screening", "verification", "shortlisted", "interview_scheduled", "interview", "interview_completed", "hm_review", "assessment", "offer", "offer_recommended", "offer_extended", "offer_accepted", "hired", "started", "rejected", "offer_declined", "withdrawn"];
  const grouped: Record<string, typeof allRows> = {};
  for (const stage of STAGES) grouped[stage] = [];
  for (const row of allRows) {
    const s = row.stage in grouped ? row.stage : "applied";
    grouped[s].push(row);
  }

  // Stack-rank within each stage: highest score first, unscored candidates last.
  for (const stage of STAGES) {
    grouped[stage].sort((a, b) => {
      const sa = a.score ?? -1;
      const sb = b.score ?? -1;
      return sb - sa;
    });
  }

  res.json({ stages: grouped, total: allRows.length });
});

/* Ensure a candidate appears on a job's pipeline board (idempotent). Inserts a
 * sourced_candidates row only if one doesn't already exist for this
 * (candidate, job), then fire-and-forget auto-screens them. Returns the sourced
 * row id. rawData.email reflects contactability — a synthetic placeholder is
 * reported as "no email" so outreach never tries to message …@unknown.local. */
async function ensureCandidateOnJob(
  candidate: typeof candidatesTable.$inferSelect,
  tenantId: string,
  jobId: string,
  notes?: string | null,
): Promise<string> {
  const realEmail = candidate.email && !candidate.email.endsWith("@unknown.local")
    ? candidate.email
    : null;

  const existing = await db.select({ id: sourcedCandidatesTable.id })
    .from(sourcedCandidatesTable)
    .where(and(
      eq(sourcedCandidatesTable.normalizedCandidateId, candidate.id),
      sql`${sourcedCandidatesTable.rawData}->>'jobId' = ${jobId}`,
    ))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const [sourced] = await db.insert(sourcedCandidatesTable).values({
    tenantId,
    source: "manual",
    normalizedCandidateId: candidate.id,
    mergeConfidence: 1,
    rawData: {
      jobId,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      email: realEmail,
      emailSynthetic: !realEmail,
      phone: candidate.phone,
      currentTitle: candidate.currentTitle,
      currentCompany: candidate.currentCompany,
      location: candidate.location,
      linkedinUrl: candidate.linkedinUrl,
      githubProfile: candidate.githubUrl,
      skills: candidate.skills,
      stage: "sourced",
      manual: true,
      notes: notes || null,
      matchScore: 80,
    },
  }).returning();

  // Fire-and-forget: auto-screen against the job's ICP so the card moves from
  // "Sourced" → "Screening" (or "Rejected"). setImmediate + try/catch so a sync
  // throw can never bubble to express after the response was already sent.
  setImmediate(() => {
    try {
      orchestrator.triggerAgent("screening", { candidateId: candidate.id, jobId, sourcedId: sourced.id }, "orchestrator")
        .catch(err => logger.error({ err: err?.message || err }, "[add-candidate] auto-screen failed"));
    } catch (err: any) {
      logger.error({ err: err?.message || err }, "[add-candidate] auto-screen threw sync");
    }
  });

  return sourced.id;
}

/* POST /jobs/:jobId/add-candidate — manually add a candidate to a job's pipeline */
router.post("/jobs/:jobId/add-candidate", validate({ body: AddCandidateBody }), async (req, res) => {
  const { jobId } = req.params;
  try {
    const gate = await gateJobAccess(req, res, jobId);
    if (!gate) return;
    const job = gate.job;
    const { firstName, lastName, email, phone, currentTitle, currentCompany, location, skills, linkedinUrl, githubUrl, notes, mergeIntoExisting } = req.body ?? {};

    if (!firstName || !lastName) { res.status(400).json({ error: "firstName and lastName required" }); return; }

    // Normalize skills to string[] regardless of how the client sent them.
    const normalizedSkills: string[] = Array.isArray(skills)
      ? skills.map((s: any) => String(s).trim()).filter(Boolean)
      : (typeof skills === "string"
          ? skills.split(",").map((s: string) => s.trim()).filter(Boolean)
          : []);

    // A person should only exist once in the recruiter's database, regardless of
    // which job they came in on. On an email collision we surface a merge prompt
    // and, on confirmation, update the existing record + link them to this job.
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (normalizedEmail) {
      const existing = await db.select().from(candidatesTable)
        .where(and(eq(candidatesTable.tenantId, job.tenantId), sql`lower(${candidatesTable.email}) = ${normalizedEmail}`))
        .limit(1);
      if (existing.length > 0) {
        const e = existing[0];
        const { values, changes } = computeCandidateMerge(e, {
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          phone: phone ? String(phone).trim() : null,
          location: location ? String(location).trim() : null,
          currentTitle: currentTitle ? String(currentTitle).trim() : null,
          currentCompany: currentCompany ? String(currentCompany).trim() : null,
          linkedinUrl: linkedinUrl ? String(linkedinUrl).trim() : null,
          githubUrl: githubUrl ? String(githubUrl).trim() : null,
          skills: normalizedSkills,
        });

        if (mergeIntoExisting === true) {
          let merged = e;
          if (Object.keys(values).length > 0) {
            const [updated] = await db.update(candidatesTable)
              .set(values)
              .where(eq(candidatesTable.id, e.id))
              .returning();
            merged = updated ?? e;
          }
          const sourcedId = await ensureCandidateOnJob(merged, job.tenantId, String(jobId), notes);
          res.status(200).json({ candidate: merged, sourcedId, merged: true });
          return;
        }

        res.status(409).json({
          error: `A candidate with email ${normalizedEmail} already exists (${e.firstName} ${e.lastName}).`,
          reason: "email_match",
          existingCandidateId: e.id,
          existing: e,
          proposedChanges: changes,
        });
        return;
      }
    }

    // The `candidates.email` column is NOT NULL. When the recruiter omits an
    // email, mint a unique placeholder so the partial unique index
    // `(tenant_id, lower(email))` doesn't collide across multiple "no-email"
    // candidates. Mirrors the bulk-import / manual-create behavior in
    // candidates.ts so this endpoint cannot 500 on a missing email.
    const emailToInsert = normalizedEmail
      || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@unknown.local`;

    // Create candidate record
    const [candidate] = await db.insert(candidatesTable).values({
      tenantId: job.tenantId,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: emailToInsert,
      phone: phone ? String(phone).trim() : null,
      currentTitle: currentTitle ? String(currentTitle).trim() : null,
      currentCompany: currentCompany ? String(currentCompany).trim() : null,
      location: location ? String(location).trim() : null,
      linkedinUrl: linkedinUrl ? String(linkedinUrl).trim() : null,
      githubUrl: githubUrl ? String(githubUrl).trim() : null,
      skills: normalizedSkills,
      source: "manual",
      verificationStatus: "unverified",
      createdById: gate.user.id,
    }).returning();

    // Add to the pipeline board + auto-screen (idempotent).
    const sourcedId = await ensureCandidateOnJob(candidate, job.tenantId, String(jobId), notes);
    res.status(201).json({ candidate, sourcedId });
  } catch (err: any) {
    // Surface the real reason instead of a bare 500 from the express default
    // handler. Logged with full context so the next failure is diagnosable.
    logger.error({ jobId, err: err?.message, stack: err?.stack, code: err?.code }, "[add-candidate] failed");
    if (!res.headersSent) {
      // Duplicate-email race: a concurrent insert slipped past our explicit
      // pre-check and tripped the (tenant, lower(email)) unique index. Recover
      // by returning the SAME structured merge prompt the pre-check would have
      // (so the recruiter UI can show the dialog + resubmit with
      // mergeIntoExisting), or by merging when they already confirmed.
      if (err?.code === "23505") {
        try {
          const body = req.body ?? {};
          const reEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          const [job2] = await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable)
            .where(eq(jobsTable.id, String(jobId))).limit(1);
          if (job2 && reEmail) {
            const [e] = await db.select().from(candidatesTable)
              .where(and(eq(candidatesTable.tenantId, job2.tenantId), sql`lower(${candidatesTable.email}) = ${reEmail}`))
              .limit(1);
            if (e) {
              const reSkills: string[] = Array.isArray(body.skills)
                ? body.skills.map((s: any) => String(s).trim()).filter(Boolean)
                : (typeof body.skills === "string"
                    ? body.skills.split(",").map((s: string) => s.trim()).filter(Boolean)
                    : []);
              const { values, changes } = computeCandidateMerge(e, {
                firstName: body.firstName ? String(body.firstName).trim() : null,
                lastName: body.lastName ? String(body.lastName).trim() : null,
                phone: body.phone ? String(body.phone).trim() : null,
                location: body.location ? String(body.location).trim() : null,
                currentTitle: body.currentTitle ? String(body.currentTitle).trim() : null,
                currentCompany: body.currentCompany ? String(body.currentCompany).trim() : null,
                linkedinUrl: body.linkedinUrl ? String(body.linkedinUrl).trim() : null,
                githubUrl: body.githubUrl ? String(body.githubUrl).trim() : null,
                skills: reSkills,
              });
              if (body.mergeIntoExisting === true) {
                let merged = e;
                if (Object.keys(values).length > 0) {
                  const [updated] = await db.update(candidatesTable)
                    .set(values).where(eq(candidatesTable.id, e.id)).returning();
                  merged = updated ?? e;
                }
                const sourcedId = await ensureCandidateOnJob(merged, job2.tenantId, String(jobId), body.notes);
                res.status(200).json({ candidate: merged, sourcedId, merged: true });
                return;
              }
              res.status(409).json({
                error: `A candidate with email ${reEmail} already exists (${e.firstName} ${e.lastName}).`,
                reason: "email_match",
                existingCandidateId: e.id,
                existing: e,
                proposedChanges: changes,
              });
              return;
            }
          }
        } catch (recoverErr: any) {
          logger.error({ jobId, err: recoverErr?.message }, "[add-candidate] 23505 merge-recovery failed");
        }
        res.status(409).json({
          error: "A candidate with this email already exists.",
          code: "23505",
        });
        return;
      }
      res.status(500).json({
        error: "Could not add candidate to pipeline.",
        detail: err?.message || "unknown server error",
        code: err?.code || null,
      });
    }
  }
});

/* Tenant-scoping helpers (mirror of applications.ts) — used to authorize
 * mutations on application rows that live under a specific job/tenant. */
async function getCallerUserPipe(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}
/* Delegates to the shared DATA-scope ceiling in lib/tenantUtils.ts: own tenant +
 * ALL descendant tenants for most roles, but a recruiter_admin is narrowed to
 * ONLY their assigned client sub-tenants. Kept as a thin wrapper so existing
 * call sites that use the `getAllowedTenantIdsPipe` name stay unchanged. */
async function getAllowedTenantIdsPipe(user: { id: string; role: string; tenantId: string | null }): Promise<string[] | null> {
  return getDataScopeTenantIds(user);
}

/* notifyHiringManager — fire an in-app notification to the job's assigned
 * hiring manager when a recruiter forwards a candidate to HM review.
 * Best-effort: any failure is logged but does NOT abort the parent action. */
async function notifyHiringManager(
  jobId: string,
  context: any,
  shape: "sourced" | "application",
  refId: string,
) {
  try {
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!job?.assignedHiringManagerId) return;

    let candidateName = "A candidate";
    let tenantId: string = job.tenantId ?? "";
    let actionUrl = `/jobs/${jobId}/pipeline`;

    if (shape === "sourced") {
      const raw = context || {};
      candidateName = `${raw.firstName ?? ""} ${raw.lastName ?? ""}`.trim() || raw.name || raw.email || candidateName;
      if (raw.interviewSessionId) actionUrl = `/interviews/${raw.interviewSessionId}`;
    } else {
      const app = context;
      tenantId = app?.tenantId ?? tenantId;
      const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, app.candidateId)).limit(1);
      if (cand) candidateName = `${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() || cand.email || candidateName;
      // Try to deep-link to the latest completed interview if we know it
      const [latest] = await db.select({ id: interviewSessionsTable.id })
        .from(interviewSessionsTable)
        .where(and(eq(interviewSessionsTable.candidateId, app.candidateId), eq(interviewSessionsTable.status, "completed")))
        .orderBy(desc(interviewSessionsTable.completedAt))
        .limit(1);
      if (latest?.id) actionUrl = `/interviews/${latest.id}`;
    }

    await db.insert(userNotificationsTable).values({
      tenantId,
      userId: job.assignedHiringManagerId,
      type: "hm_review_requested",
      title: "Candidate ready for your review",
      message: `${candidateName} has been forwarded for your review${job.title ? ` for ${job.title}` : ""}. Watch the recording and decide on next steps.`,
      actionUrl,
    });
    const { recordAudit } = await import("../lib/audit.js");
    void recordAudit({
      tenantId,
      actorType: "system",
      actorLabel: "Pipeline Engine",
      subjectType: "user",
      subjectId: job.assignedHiringManagerId,
      subjectLabel: candidateName,
      channel: "in_app",
      direction: "outbound",
      action: "notification.user.hm_review_requested",
      title: "Candidate ready for your review",
      body: `${candidateName} has been forwarded for review${job.title ? ` for ${job.title}` : ""}.`,
      metadata: { jobId: job.id, candidateName, actionUrl },
    });

    /* Email the hiring manager so they get notified outside the app too.
     * Best-effort: log and continue if the user has no email or the send
     * fails. Deep-links into the same actionUrl as the in-app notification
     * (interview review page when available, pipeline view otherwise). */
    try {
      const [hmUser] = await controlDb.select().from(usersTable).where(eq(usersTable.id, job.assignedHiringManagerId)).limit(1);
      if (hmUser?.email) {
        const { sendEmail, plainToHtml, isEmailConfigured } = await import("../lib/email.js");
        if (isEmailConfigured()) {
          const hmFirst = (hmUser.name ?? "").split(" ")[0] || "there";
          const reviewUrl = `${process.env.APP_BASE_URL || "https://app.l3xy.ai"}${actionUrl}`;
          const subject = `${candidateName} is ready for your review${job.title ? ` — ${job.title}` : ""}`;
          const body = `Hi ${hmFirst},

${candidateName} has been forwarded to you for review${job.title ? ` for the ${job.title} role` : ""}. Take a look at the interview recording and AI summary, then decide on next steps.

Review the candidate here:
${reviewUrl}

— Lexy AI Hiring Platform`;
          void sendEmail({
            to: hmUser.email,
            subject,
            text: body,
            html: plainToHtml(body),
            audit: {
              tenantId,
              actorLabel: "Pipeline Engine",
              subjectType: "user",
              subjectId: job.assignedHiringManagerId,
              subjectLabel: hmUser.name ?? hmUser.email,
              action: "pipeline.hm_review_requested.email",
              metadata: { jobId: job.id, candidateName, actionUrl },
            },
          }).catch((err) => logger.error({ err }, "[notifyHiringManager] email send failed"));
        }
      }
    } catch (err) {
      logger.error({ err }, "[notifyHiringManager] email lookup failed");
    }
  } catch (err) {
    logger.error({ err }, "[notifyHiringManager] failed");
  }
}

/* POST /jobs/:jobId/pipeline/card-action — per-card pipeline actions */
router.post("/jobs/:jobId/pipeline/card-action", validate({ body: CardActionBody }), async (req, res) => {
  const { jobId } = req.params;
  /* Authn+authz at the entrypoint — sub-actions like send_to_verify,
     log_reply, send_outreach and accept_interview previously executed
     anonymously. */
  const gate = await gateJobAccess(req, res, jobId);
  if (!gate) return;
  const gatedJob = gate.job;
  const { action, sourcedId, applicationId } = req.body;

  if (!action) { res.status(400).json({ error: "action required" }); return; }
  /* `send_to_hm` works for both sourced rows and real applications, so it
   * gets dispatched first below before the sourced lookup. All other actions
   * still require a sourced candidate. */
  if (action !== "send_to_hm" && action !== "reject_candidate" && !sourcedId) {
    res.status(400).json({ error: "sourcedId required for this action" });
    return;
  }

  const [s] = sourcedId
    ? await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, sourcedId)).limit(1)
    : [null as any];
  if (sourcedId && !s) { res.status(404).json({ error: "Sourced candidate not found" }); return; }

  /* Sourced-row IDOR guard for the sub-actions (send_to_verify, log_reply,
     send_outreach, accept_interview). The entrypoint gate proves the caller
     can act on `jobId`; this proves the supplied `sourcedId` actually belongs
     to that job + tenant. Cross-tenant returns 404 (not 403) to avoid
     enumerating sourced-candidate IDs. */
  if (s) {
    if ((s.tenantId ?? "") !== (gatedJob.tenantId ?? "")) {
      res.status(404).json({ error: "Sourced candidate not found" }); return;
    }
    const rawData = (s.rawData as any) || {};
    if (rawData.jobId && rawData.jobId !== jobId) {
      res.status(404).json({ error: "Sourced candidate not found" }); return;
    }
  }

  const raw = (s?.rawData as any) || {};

  if (action === "send_to_verify") {
    // Move from screening → verification AND actually run the Verification Agent
    // on this single candidate so the card shows real verdict + flags + notes.
    const ctx = {
      name: `${raw?.firstName || ""} ${raw?.lastName || ""}`.trim(),
      email: raw?.email || null,
      phone: raw?.phone || null,
      linkedinUrl: raw?.linkedinUrl || null,
      currentTitle: raw?.currentTitle || "",
      currentCompany: raw?.currentCompany || "",
      location: raw?.location || "",
      skills: raw?.skills || [],
      source: s.source,
    };

    const { verificationResult, verificationStatus } = await runVerificationAgent(ctx);

    if (s.normalizedCandidateId) {
      await changeCandidateStage({
        tenantId: s.tenantId ?? "",
        candidateId: s.normalizedCandidateId,
        jobId,
        to: "verification",
        actor: { type: "user", role: (gate.user as any)?.role ?? null, id: (gate.user as any)?.id ?? null },
        source: "recruiter_action",
        sourcedId,
        sourcedRawDataPatch: { jobId, verified: true, verificationStatus, verificationResult },
        metadata: { action: "send_to_verify" },
      });
    } else {
      // stage-write-exempt: sourced row has no canonical candidateId to key the STAGE_CHANGED event/audit rows
      await db.update(sourcedCandidatesTable).set({
        rawData: {
          ...raw,
          stage: "verification",
          verified: true,
          verificationStatus,
          verificationResult,
        },
      }).where(eq(sourcedCandidatesTable.id, sourcedId));
    }

    // Mirror status + full result onto the normalized candidate record if linked
    if (s.normalizedCandidateId) {
      await db.update(candidatesTable).set({
        verificationStatus: verificationStatus as any,
        verificationResult,
        updatedAt: new Date(),
      }).where(eq(candidatesTable.id, s.normalizedCandidateId)).catch(() => {});
    }

    /* Emit lifecycle event for the verification stage advance (sourced path) */
    if (s.normalizedCandidateId) {
      void logCandidateEvent({
        candidateId: s.normalizedCandidateId,
        jobId,
        tenantId: s.tenantId ?? "",
        eventType: "RECRUITER_SHORTLISTED",
        actorType: "recruiter",
        source: "recruiter_action",
        metadata: { stage: "verification", action: "send_to_verify" },
      });
    }

    res.json({ ok: true, stage: "verification", verificationStatus, verificationResult });
    return;
  }

  if (action === "log_reply") {
    // Recruiter manually logs a candidate reply that came in via email/whatever.
    // sentiment: "positive" → advance toward interview, "negative" → reject, "do_not_contact" → DNC
    const sentiment = (req.body.sentiment as string) || "positive";
    const replyBody = (req.body.replyBody as string) || "";
    if (!["positive", "negative", "do_not_contact"].includes(sentiment)) {
      res.status(400).json({ error: "sentiment must be positive, negative, or do_not_contact" });
      return;
    }

    // Find the latest outreach message for this candidate (sourcedId or normalized id) for this job
    const candidateLookupId = s.normalizedCandidateId || sourcedId;
    const msgs = await db.select().from(outreachMessagesTable)
      .where(and(
        eq(outreachMessagesTable.jobId, jobId),
        inArray(outreachMessagesTable.candidateId, [sourcedId, candidateLookupId]),
      ))
      .orderBy(desc(outreachMessagesTable.createdAt))
      .limit(1);

    if (msgs.length > 0) {
      await db.update(outreachMessagesTable).set({
        status: "replied",
        repliedAt: new Date(),
        replySentiment: sentiment as any,
        replyBody: replyBody || (msgs[0] as any).replyBody || null,
      } as any).where(eq(outreachMessagesTable.id, msgs[0].id));
    }

    // Update sourced candidate stage based on sentiment
    const stageMap: Record<string, string> = {
      positive: "interview_scheduled",  // ready to schedule the interview
      negative: "rejected",
      do_not_contact: "rejected",
    };
    const nextStage = stageMap[sentiment];

    // For positive replies, fire the GenAI interview-invite flow:
    // creates a 24h-token interview session, AI-drafts a personalised
    // confirmation email, sends via SES, and audit-logs to comm_events.
    let inviteResult: any = null;
    if (sentiment === "positive") {
      try {
        const { sendInterviewInviteFromReply } = await import("../lib/agents/interview-reply");
        inviteResult = await sendInterviewInviteFromReply({ jobId, sourcedId, replyBody });
      } catch (err: any) {
        inviteResult = { ok: false, error: err?.message || String(err) };
      }
    }

    /* Track whether THIS request is the one that flips the candidate to
     * "rejected" so we send the candidate-facing email exactly once. */
    const wasAlreadyRejected = (raw?.stage === "rejected");

    const replyRawPatch: Record<string, unknown> = {
      replyStatus: sentiment,
      replyLoggedAt: new Date().toISOString(),
      replyBody: replyBody || raw?.replyBody || null,
      ...(inviteResult?.sessionId
        ? {
            interviewSessionId: inviteResult.sessionId,
            interviewInviteSentAt: new Date().toISOString(),
            interviewInviteEmailOk: !!inviteResult.emailOk,
          }
        : {}),
    };
    if (s.normalizedCandidateId) {
      await changeCandidateStage({
        tenantId: s.tenantId ?? "",
        candidateId: s.normalizedCandidateId,
        jobId,
        to: nextStage,
        actor: { type: "user", role: (gate.user as any)?.role ?? null, id: (gate.user as any)?.id ?? null },
        source: "recruiter_action",
        sourcedId,
        sourcedRawDataPatch: { jobId, ...replyRawPatch },
        metadata: { action: "log_reply", sentiment },
      });
    } else {
      // stage-write-exempt: sourced row has no canonical candidateId to key the STAGE_CHANGED event/audit rows
      await db.update(sourcedCandidatesTable).set({
        rawData: { ...raw, stage: nextStage, ...replyRawPatch },
      }).where(eq(sourcedCandidatesTable.id, sourcedId));
    }

    // Mirror DNC flag on normalized candidate if applicable
    if (sentiment === "do_not_contact" && s.normalizedCandidateId) {
      await db.update(candidatesTable).set({
        doNotContact: true,
        updatedAt: new Date(),
      } as any).where(eq(candidatesTable.id, s.normalizedCandidateId)).catch(() => {});
    }

    /* Persist a `candidate_rejections` audit row + send the polite email
     * when this reply moved the candidate to "rejected". Idempotent via
     * wasAlreadyRejected. Reason is auto-derived from sentiment so we
     * always have a record of WHY ("Candidate declined" vs "Do not
     * contact"). The actual reply body is captured as the long-form
     * notes so the recruiter / auditor can read the candidate's words. */
    if (nextStage === "rejected" && !wasAlreadyRejected) {
      const autoReason = sentiment === "do_not_contact"
        ? "Do not contact (candidate request)"
        : "Candidate declined opportunity";
      (async () => {
        try {
          const { recordRejection } = await import("../lib/record-rejection.js");
          await recordRejection({
            tenantId: s.tenantId ?? "",
            jobId,
            sourcedId,
            candidateId: s.normalizedCandidateId ?? null,
            rejectedByRole: "recruiter",
            reason: autoReason,
            notes: replyBody || null,
            fromStage: raw?.stage ?? null,
            sendEmail: true,
          });
        } catch (err) {
          logger.error({ err }, "[log_reply] candidate rejection record/email failed");
        }
      })();
    }

    /* Emit lifecycle event for the reply-driven stage advance (sourced path) */
    if (s.normalizedCandidateId) {
      const replyEventMap: Record<string, "INTERVIEW_INVITED" | "REJECTED"> = {
        interview_scheduled: "INTERVIEW_INVITED",
        rejected: "REJECTED",
      };
      const replyEvType = replyEventMap[nextStage];
      if (replyEvType) {
        void logCandidateEvent({
          candidateId: s.normalizedCandidateId,
          jobId,
          tenantId: s.tenantId ?? "",
          eventType: replyEvType,
          actorType: "recruiter",
          source: "recruiter_action",
          metadata: { fromStage: raw?.stage ?? null, sentiment, nextStage },
        });
      }
    }

    res.json({
      ok: true,
      stage: nextStage,
      sentiment,
      messageUpdated: msgs.length > 0,
      interviewInvite: inviteResult,
    });
    return;
  }

  if (action === "send_outreach") {
    // Contact-email guardrail (NON-overridable): refuse to run outreach for a
    // candidate with no real email on file. Otherwise the run produces a draft
    // that can never be sent, recreating the "Outreach Queued but unmessageable"
    // contradiction. Surface an actionable message immediately, before spinning
    // up an agent run.
    const outreachEmail =
      (raw?.email as string | undefined) ||
      (s.normalizedCandidateId
        ? await db
            .select({ email: candidatesTable.email })
            .from(candidatesTable)
            .where(eq(candidatesTable.id, s.normalizedCandidateId))
            .limit(1)
            .then((rows) => rows[0]?.email ?? null)
        : null);
    if (!isRealEmail(typeof outreachEmail === "string" ? outreachEmail : "")) {
      res.status(422).json({
        ok: false,
        error: "This candidate has no email address on file — add or enrich an email before running outreach.",
        code: "NO_CONTACT_EMAIL",
      });
      return;
    }

    // Run the Outreach Agent synchronously so we can surface SES errors
    // back to the UI. The agent generates the AI email and dispatches it
    // through Amazon SES (email.ts).
    const agentRun = await orchestrator.triggerAgent(
      "outreach",
      { jobId, candidateId: sourcedId, passedCandidateIds: [sourcedId] },
      "user",
    );

    const out: any = agentRun.output ?? {};
    const sent = Number(out.messagesSent ?? 0);
    const failed = Number(out.messagesFailed ?? 0);
    const pending = Number(out.messagesPending ?? 0);
    const errors: Array<{ error: string; email?: string }> = Array.isArray(out.sendErrors) ? out.sendErrors : [];
    const firstError = errors[0]?.error || agentRun.error;

    // Approval flow (default) — a first-touch draft was generated and is being
    // HELD for recruiter sign-off rather than sent. This is the success path,
    // not a failure: the draft now sits in the approval queue (Outreach →
    // Approvals) where a recruiter reviews and approves it to send. We do NOT
    // advance the stage here; that happens on approval.
    if (pending > 0) {
      res.json({
        ok: true,
        pendingApproval: true,
        messagesPending: pending,
        outreachIds: Array.isArray(out.outreachIds) ? out.outreachIds : [],
      });
      return;
    }

    // Nothing generated — surface the agent's own reason (e.g. candidate not
    // verified yet, AI messaging disabled for the tenant) instead of a generic
    // error, so the recruiter knows the next step.
    if (agentRun.status === "failed" || (sent === 0 && failed === 0 && pending === 0 && !out.messagesQueued)) {
      res.status(agentRun.status === "failed" ? 502 : 422).json({
        ok: false,
        error: out.message || agentRun.error || "Outreach agent did not produce a message",
        skippedUnverified: out.skippedUnverified,
        aiDisabled: out.aiDisabled === true,
      });
      return;
    }

    // Soft failure — message generated but SES rejected it (e.g. unverified
    // sender, sandbox-mode recipient, missing email on candidate)
    if (sent === 0 && failed > 0) {
      res.status(502).json({
        ok: false,
        stage: "verification",
        error: firstError || "Email send failed",
        sendErrors: errors,
      });
      return;
    }

    // Success — flip stage to shortlisted (Outreach Queued column)
    if (s.normalizedCandidateId) {
      await changeCandidateStage({
        tenantId: s.tenantId ?? "",
        candidateId: s.normalizedCandidateId,
        jobId,
        to: "shortlisted",
        actor: { type: "user", role: (gate.user as any)?.role ?? null, id: (gate.user as any)?.id ?? null },
        source: "recruiter_action",
        sourcedId,
        sourcedRawDataPatch: { jobId, outreachSent: true },
        metadata: { action: "send_outreach" },
      });
    } else {
      // stage-write-exempt: sourced row has no canonical candidateId to key the STAGE_CHANGED event/audit rows
      await db.update(sourcedCandidatesTable).set({
        rawData: { ...raw, outreachSent: true, stage: "shortlisted" },
      }).where(eq(sourcedCandidatesTable.id, sourcedId));
    }

    res.json({
      ok: true,
      stage: "shortlisted",
      messagesSent: sent,
      messagesFailed: failed,
      sendErrors: errors,
    });
    return;
  }

  if (action === "accept_interview") {
    /* Send the invite email + create the interview session via the same
     * agent used by the webhook positive-reply path. This guarantees:
     *  1. The candidate receives the interview link email.
     *  2. The sourced candidate stage is atomically set to
     *     "interview_scheduled" (Scheduled column) by the agent itself.
     * Verify that the sourced candidate has an email address first. */
    const candidateEmail =
      (raw?.email as string | undefined) ||
      (s.normalizedCandidateId
        ? await db
            .select({ email: candidatesTable.email })
            .from(candidatesTable)
            .where(eq(candidatesTable.id, s.normalizedCandidateId))
            .limit(1)
            .then((rows) => rows[0]?.email ?? null)
        : null);

    if (!candidateEmail) {
      res.status(400).json({ ok: false, error: "Candidate has no email address on file — cannot send interview invite." });
      return;
    }

    const { sendInterviewInviteFromReply } = await import("../lib/agents/interview-reply.js");
    const inviteResult = await sendInterviewInviteFromReply({ jobId, sourcedId });

    if (!inviteResult.ok) {
      res.status(502).json({ ok: false, error: inviteResult.error || "Failed to send interview invite" });
      return;
    }

    res.json({
      ok: true,
      stage: "interview_scheduled",
      sessionId: inviteResult.sessionId,
      inviteUrl: inviteResult.inviteUrl,
      emailOk: inviteResult.emailOk,
    });
    return;
  }

  /* send_to_hm — recruiter forwards a finished interview to the hiring
   * manager for review. Works for both candidate-tracking shapes:
   *   - Sourced row: write `raw_data.stage = "hm_review"`.
   *   - Real application: PUT through the applications PUT route's logic
   *     would also work, but to keep this single-endpoint we update the
   *     row directly here. */
  if (action === "send_to_hm") {
    if (sourcedId) {
      /* Sourced branch — apply the same authz rigor as the application
       * branch: caller must be authenticated, the sourced row's job
       * (`raw_data.jobId`) must equal the URL `jobId`, and the caller's
       * tenant must include the job's tenant unless they are platform_admin. */
      const caller = await getCallerUserPipe(req);
      if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }

      const [s] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, sourcedId)).limit(1);
      if (!s) { res.status(404).json({ error: "Sourced candidate not found" }); return; }
      const raw = (s.rawData as any) || {};

      const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
      if (!job) { res.status(404).json({ error: "Job not found" }); return; }
      if (raw.jobId && raw.jobId !== jobId) {
        res.status(404).json({ error: "Sourced candidate does not belong to this job" });
        return;
      }
      const allowed = await getAllowedTenantIdsPipe(caller as any);
      if (allowed && !allowed.includes(job.tenantId ?? "")) {
        res.status(404).json({ error: "Not found" });
        return;
      }

      /* Idempotency: if already in hm_review, return success but skip the
       * notification insert so retries don't spam the hiring manager. */
      const alreadyInReview = raw.stage === "hm_review";
      if (!alreadyInReview) {
        if (s.normalizedCandidateId) {
          await changeCandidateStage({
            tenantId: s.tenantId ?? job.tenantId ?? "",
            candidateId: s.normalizedCandidateId,
            jobId,
            to: "hm_review",
            actor: { type: "user", role: (caller as any)?.role ?? null, id: (caller as any)?.id ?? null },
            source: "recruiter_action",
            sourcedId,
            sourcedRawDataPatch: { jobId, sentToHmAt: new Date().toISOString() },
            metadata: { action: "send_to_hm" },
          });
        } else {
          // stage-write-exempt: sourced row has no canonical candidateId to key the STAGE_CHANGED event/audit rows
          await db.update(sourcedCandidatesTable)
            .set({ rawData: { ...raw, stage: "hm_review", sentToHmAt: new Date().toISOString() } })
            .where(eq(sourcedCandidatesTable.id, sourcedId));
        }
        await notifyHiringManager(jobId, raw, "sourced", sourcedId);
      }
      res.json({ ok: true, stage: "hm_review", deduped: alreadyInReview });
      return;
    }
    if (applicationId) {
      /* Application branch — full authz: 1) caller must be authenticated,
       * 2) the application must belong to this jobId (no cross-job IDOR),
       * 3) the caller's tenant must include the application tenant unless
       *    they are a platform_admin. */
      const caller = await getCallerUserPipe(req);
      if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }

      const [appRow] = await db.select().from(applicationsTable)
        .where(eq(applicationsTable.id, applicationId)).limit(1);
      if (!appRow) { res.status(404).json({ error: "Application not found" }); return; }
      if (appRow.jobId !== jobId) {
        res.status(404).json({ error: "Application does not belong to this job" });
        return;
      }
      const allowed = await getAllowedTenantIdsPipe(caller as any);
      if (allowed && !allowed.includes(appRow.tenantId ?? "")) {
        res.status(404).json({ error: "Not found" });
        return;
      }

      if (appRow.candidateId) {
        await changeCandidateStage({
          tenantId: appRow.tenantId ?? "",
          candidateId: appRow.candidateId,
          jobId,
          to: "hm_review",
          actor: { type: "user", role: (caller as any)?.role ?? null, id: (caller as any)?.id ?? null },
          source: "recruiter_action",
          applicationId,
          metadata: { action: "send_to_hm" },
        });
      } else {
        // stage-write-exempt: application has no candidateId to key the STAGE_CHANGED event/audit rows
        const updated = await db.update(applicationsTable)
          .set({ stage: "hm_review", updatedAt: new Date() })
          .where(eq(applicationsTable.id, applicationId))
          .returning({ id: applicationsTable.id });
        if (updated.length === 0) { res.status(404).json({ error: "Application not found" }); return; }
      }

      await notifyHiringManager(jobId, appRow, "application", applicationId);

      res.json({ ok: true, stage: "hm_review" });
      return;
    }
    res.status(400).json({ error: "send_to_hm requires sourcedId or applicationId" });
    return;
  }

  /* ── Explicit Reject ───────────────────────────────────────────────────
   * Marks the candidate as "rejected" from any current stage. Works for
   * both sourced rows and real applications. Captures the rejector's
   * reason + free-form notes, persists a `candidate_rejections` audit
   * row, and sends the polite candidate-facing email. The rejector's
   * role (recruiter vs hiring_manager) is taken from the authenticated
   * caller so the audit row always knows WHO rejected.
   *   Body: { sourcedId | applicationId, reason?, notes? } */
  if (action === "reject_candidate") {
    const caller = await getCallerUserPipe(req);
    if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }
    const reason: string | null = (req.body?.reason ?? null) || null;
    const notes: string | null = (req.body?.notes ?? null) || null;
    const rejectedByRole: "recruiter" | "hiring_manager" =
      (caller as any).role === "hiring_manager" ? "hiring_manager" : "recruiter";

    const { recordRejection } = await import("../lib/record-rejection.js");

    if (sourcedId) {
      const [s] = await db.select().from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.id, sourcedId)).limit(1);
      if (!s) { res.status(404).json({ error: "Sourced candidate not found" }); return; }
      const raw = (s.rawData as any) || {};
      const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
      if (!job) { res.status(404).json({ error: "Job not found" }); return; }
      if (raw.jobId && raw.jobId !== jobId) {
        res.status(404).json({ error: "Sourced candidate does not belong to this job" });
        return;
      }
      const allowed = await getAllowedTenantIdsPipe(caller as any);
      if (allowed && !allowed.includes(job.tenantId ?? "")) {
        res.status(404).json({ error: "Not found" }); return;
      }

      const wasAlreadyRejected = raw.stage === "rejected";
      const fromStage = raw.stage ?? null;

      if (!wasAlreadyRejected) {
        /* Only email the candidate if outreach was ACTUALLY sent. A sourced
         * candidate who was rejected before we ever contacted them must not
         * receive a rejection email — that email would be the first (and only)
         * message they ever get from us, exposing that they were silently in a
         * pipeline they never opted into. "Contacted" = an outreach message in
         * status sent/replied for this candidate + job. Simulated sends stay
         * "queued" and correctly do NOT count. */
        const candidateLookupId = s.normalizedCandidateId || sourcedId;
        const [contacted] = await db.select({ id: outreachMessagesTable.id })
          .from(outreachMessagesTable)
          .where(and(
            eq(outreachMessagesTable.jobId, jobId),
            inArray(outreachMessagesTable.candidateId, [sourcedId, candidateLookupId]),
            inArray(outreachMessagesTable.status, ["sent", "replied"]),
          ))
          .limit(1);
        const outreachSent = !!contacted;

        if (s.normalizedCandidateId) {
          await changeCandidateStage({
            tenantId: s.tenantId ?? job.tenantId ?? "",
            candidateId: s.normalizedCandidateId,
            jobId,
            to: "rejected",
            actor: { type: rejectedByRole === "hiring_manager" ? "hiring_manager" : "user", role: rejectedByRole, id: (caller as any).id ?? null },
            source: "recruiter_action",
            reason: [reason, notes].filter(Boolean).join(" — ") || null,
            sourcedId,
            sourcedRawDataPatch: {
              jobId,
              rejectedAt: new Date().toISOString(),
              rejectedByUserId: (caller as any).id ?? null,
              rejectionReason: reason,
              rejectionNotes: notes,
            },
            metadata: { action: "reject_candidate" },
          });
        } else {
          // stage-write-exempt: sourced row has no canonical candidateId to key the STAGE_CHANGED event/audit rows
          await db.update(sourcedCandidatesTable).set({
            rawData: {
              ...raw,
              stage: "rejected",
              rejectedAt: new Date().toISOString(),
              rejectedByUserId: (caller as any).id ?? null,
              rejectionReason: reason,
              rejectionNotes: notes,
            },
          }).where(eq(sourcedCandidatesTable.id, sourcedId));
        }

        const result = await recordRejection({
          tenantId: s.tenantId ?? job.tenantId ?? "",
          jobId,
          sourcedId,
          candidateId: s.normalizedCandidateId ?? null,
          rejectedByUserId: (caller as any).id ?? null,
          rejectedByRole,
          reason,
          notes,
          fromStage,
          sendEmail: outreachSent,
        });
        res.json({
          ok: true,
          stage: "rejected",
          rejectionId: result.rejectionId,
          emailOk: result.emailOk,
          emailSkipped: !outreachSent,
        });
        return;
      }
      res.json({ ok: true, stage: "rejected", deduped: true });
      return;
    }

    if (applicationId) {
      const [appRow] = await db.select().from(applicationsTable)
        .where(eq(applicationsTable.id, applicationId)).limit(1);
      if (!appRow) { res.status(404).json({ error: "Application not found" }); return; }
      if (appRow.jobId !== jobId) {
        res.status(404).json({ error: "Application does not belong to this job" });
        return;
      }
      const allowed = await getAllowedTenantIdsPipe(caller as any);
      if (allowed && !allowed.includes(appRow.tenantId ?? "")) {
        res.status(404).json({ error: "Not found" }); return;
      }

      const wasAlreadyRejected = appRow.stage === "rejected";
      const fromStage = appRow.stage ?? null;

      if (!wasAlreadyRejected) {
        /* Pre-resolve the linked sourced row so the applications.stage write and
         * its sourced rawData.stage mirror commit atomically in one transaction
         * (replaces the old fire-and-forget mirror block below). */
        let rejectSourcedId: string | null = null;
        if (appRow.candidateId) {
          const [sc] = await db.select({ id: sourcedCandidatesTable.id })
            .from(sourcedCandidatesTable)
            .where(eq(sourcedCandidatesTable.normalizedCandidateId, appRow.candidateId))
            .limit(1);
          rejectSourcedId = sc?.id ?? null;
        }
        if (appRow.candidateId) {
          await changeCandidateStage({
            tenantId: appRow.tenantId ?? "",
            candidateId: appRow.candidateId,
            jobId,
            to: "rejected",
            actor: { type: rejectedByRole === "hiring_manager" ? "hiring_manager" : "user", role: rejectedByRole, id: (caller as any).id ?? null },
            source: "recruiter_action",
            reason: [reason, notes].filter(Boolean).join(" — ") || null,
            applicationId,
            sourcedId: rejectSourcedId,
            sourcedRawDataPatch: rejectSourcedId ? { rejectionReason: reason, rejectionNotes: notes } : undefined,
            metadata: { action: "reject_candidate" },
          });
        } else {
          // stage-write-exempt: application has no candidateId to key the STAGE_CHANGED event/audit rows
          await db.update(applicationsTable)
            .set({ stage: "rejected", updatedAt: new Date() })
            .where(eq(applicationsTable.id, applicationId));
        }

        /* Governance: this is a human-initiated reject from the
         * pipeline kanban. Write final_decision through the
         * enforcement service so the audit trail captures who
         * attested. Best-effort; legacy stage write above already
         * persisted. */
        try {
          const { applyHumanDecision } = await import("../lib/governance/decision-enforcement.js");
          await applyHumanDecision({
            applicationId,
            finalDecision: "human_reject",
            decidedByUserId: (caller as any).id ?? "system_unknown_user",
            decidedByRole: (rejectedByRole as any) ?? "recruiter",
            attestation:
              "I reviewed the AI recommendations and role-relevant candidate information before confirming this action (recorded via pipeline reject UI).",
            reason: [reason, notes].filter(Boolean).join(" — ") || null,
          });
        } catch (err) {
          logger.warn({ err }, "[governance] applyHumanDecision failed (non-fatal)");
        }

        /* Auto-capture the terminal "rejected" outcome for the learning loop.
         * Best-effort; must not roll back the reject. */
        if (appRow.candidateId) {
          (async () => {
            try {
              const { recordTerminalOutcome } = await import("../lib/record-terminal-outcome.js");
              await recordTerminalOutcome({
                tenantId: appRow.tenantId ?? "",
                applicationId,
                candidateId: appRow.candidateId!,
                jobId,
                outcome: "rejected",
                source: "auto:pipeline-reject",
              });
            } catch (err) {
              logger.warn({ err, applicationId }, "Failed to auto-capture reject outcome (non-fatal)");
            }
          })();
        }

        // (sourced mirror folded into the atomic changeCandidateStage call above)

        const result = await recordRejection({
          tenantId: appRow.tenantId ?? "",
          jobId,
          applicationId,
          candidateId: appRow.candidateId,
          rejectedByUserId: (caller as any).id ?? null,
          rejectedByRole,
          reason,
          notes,
          fromStage,
          sendEmail: true,
        });
        res.json({ ok: true, stage: "rejected", rejectionId: result.rejectionId, emailOk: result.emailOk });
        return;
      }
      res.json({ ok: true, stage: "rejected", deduped: true });
      return;
    }

    res.status(400).json({ error: "reject_candidate requires sourcedId or applicationId" });
    return;
  }

  res.status(400).json({ error: `Unknown action: ${action}` });
});

export default router;
