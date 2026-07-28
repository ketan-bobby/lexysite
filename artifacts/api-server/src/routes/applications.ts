/**
 * routes/applications.ts — Job Application CRUD & Stage Management
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for managing candidate applications: creating, listing, updating
 * stages, and triggering agent screening runs. This is the primary route used
 * by the Applications tab of both the Candidates and Jobs detail pages.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET    /applications            List applications (tenant-scoped, filterable by
 *                                   jobId / candidateId / stage)
 *   POST   /applications            Create a new application; optionally triggers the
 *                                   screening agent immediately
 *   GET    /applications/:id        Get one application, enriched with job + candidate
 *   PATCH  /applications/:id        Update stage / notes / assignee
 *   DELETE /applications/:id        Hard-delete an application
 *   POST   /applications/:id/screen Run the Screening agent for this application
 *   POST   /applications/bulk-screen Run screening for all pending applications on a job
 *
 * ─── Stage transitions ───────────────────────────────────────────────────────
 * PATCH /applications/:id enforces these side-effects on stage change:
 *   → "rejected"           Calls recordRejection() (email + audit row)
 *   → "interview_scheduled" Calls sendInterviewInviteFromReply() if the candidate
 *                           has a reply on record
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * platform_admin → no filter.
 * tenant users   → filter by tenantId IN (own + child tenants).
 * Local getAllowedTenantIds() is a simplified copy of the lib version; both
 * implement the same parent → child expansion logic.
 *
 * ─── mapApplication() ────────────────────────────────────────────────────────
 * Joins each application with its job + candidate rows and normalises
 * Date → ISO string so the frontend never receives raw Date objects.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import { applicationsTable, jobsTable, candidatesTable, icpTable, sourcedCandidatesTable, usersTable, tenantsTable, interviewSessionsTable } from "@workspace/db";
import { eq, count, desc, and, inArray } from "drizzle-orm";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";
import { orchestrator } from "../lib/agents/orchestrator";
import { logger } from "../lib/logger";
import { recruiterLinkOrigin } from "../lib/sourcing-origin";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { isRealEmail } from "../lib/real-email";
import { assertJobApproved } from "../lib/job-approval-gate";
import { ensureCandidateUser, generateInviteToken } from "./invites";
import { getAuthUserId } from "../lib/auth-token";
import { getAllowedTenantIds, getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { validate } from "../middlewares/validate";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";

const router: IRouter = Router();

/* ── Request body schemas ────────────────────────────────────────────────── */
const CreateApplicationBody = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  stage: z.string().min(1).optional(),
  notes: z.string().optional().nullable(),
}).passthrough();

/* Strict allowlist — the handler does `.set({ ...req.body, updatedAt })`,
 * so any extra key would land on the row. Zod strips unknown keys by
 * default (no .passthrough()), closing the mass-assignment surface:
 * a caller cannot use this PUT to rewrite tenantId, candidateId, jobId,
 * createdAt, etc. */
const UpdateApplicationBody = z.object({
  stage: z.string().min(1).optional(),
  notes: z.string().optional().nullable(),
  rejectionReason: z.string().optional().nullable(),
  rejectionNotes: z.string().optional().nullable(),
  rejection_reason: z.string().optional().nullable(),
  rejection_notes: z.string().optional().nullable(),
  overrideInterviewGate: z.boolean().optional(),
  /* Explicit manual placement: the recruiter is dropping the candidate into a
   * stage WITHOUT triggering any of that stage's automation (no screening /
   * verification / outreach agents, no interview invite, no rejection email).
   * Used for candidates who progressed through an off-platform path (e.g. the
   * client ran their own interviews) and just need to be reflected at the right
   * stage. Ordering gates (offer/hired/started) are also bypassed because the
   * linear pipeline assumptions don't hold for these out-of-band candidates. */
  skipAutomation: z.boolean().optional(),
});

/* ── Auth helper ─────────────────────────────────────────────────────────── */
async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/* Tenant visibility scoping (own tenant + ALL descendant tenants) is shared in
 * lib/tenantUtils.ts getAllowedTenantIds, imported below. */

/* ── Map helper ───────────────────────────────────────────────────────────── */
async function mapApplication(a: any) {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, a.jobId)).limit(1);
  const [candidate] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, a.candidateId)).limit(1);
  return {
    ...a,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    job: job ? { ...job, applicationCount: 0, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString() } : null,
    candidate: candidate ? { ...candidate, applicationCount: 0, skills: candidate.skills || [], createdAt: candidate.createdAt.toISOString(), updatedAt: candidate.updatedAt.toISOString() } : null,
  };
}

/* ── GET /applications ────────────────────────────────────────────────────── */
router.get("/applications", async (req, res) => {
  const user = await getCallerUser(req);
  /* Mandatory auth — without this the route returned every tenant's
     applications to anonymous callers. */
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { jobId, candidateId, stage } = req.query;

  /* Defensive cap (see lib/query-limits.ts) + push tenant scope into SQL so a
     small tenant doesn't get a zero-row slice from a global top-1000 cap. */
  let apps: any[];
  if (user.role === "platform_admin") {
    apps = await db.select().from(applicationsTable).orderBy(desc(applicationsTable.createdAt)).limit(MAX_PAGE_SIZE);
  } else {
    /* Data-scope ceiling: recruiter_admin -> assigned client tenants only
       (empty => nothing); everyone else -> agency subtree. */
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || allowed.length === 0) { res.json([]); return; }
    const whereClauses: any[] = [inArray(applicationsTable.tenantId, allowed)];
    /* Recruiter ownership ceiling: a plain recruiter sees ONLY applications for
       requisitions assigned to them. Empty assignment set => nothing. */
    if (user.role === "recruiter") {
      const assignedJobIds = await getRecruiterAssignedJobIds(user);
      if (assignedJobIds.length === 0) { res.json([]); return; }
      whereClauses.push(inArray(applicationsTable.jobId, assignedJobIds));
    }
    apps = await db.select().from(applicationsTable)
      .where(and(...whereClauses))
      .orderBy(desc(applicationsTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  }

  if (jobId) apps = apps.filter(a => a.jobId === jobId);
  if (candidateId) apps = apps.filter(a => a.candidateId === candidateId);
  if (stage) apps = apps.filter(a => a.stage === stage);

  // Exclude applications belonging to GDPR-erased candidates
  const candIds = Array.from(new Set(apps.map(a => a.candidateId).filter(Boolean))) as string[];
  if (candIds.length > 0) {
    const erased = await db.select({ id: candidatesTable.id, dataErasedAt: candidatesTable.dataErasedAt })
      .from(candidatesTable)
      .where(inArray(candidatesTable.id, candIds));
    const erasedIds = new Set(erased.filter(c => (c as any).dataErasedAt).map(c => c.id));
    if (erasedIds.size > 0) apps = apps.filter(a => !erasedIds.has(a.candidateId as any));
  }

  const mapped = await Promise.all(apps.map(mapApplication));
  res.json(mapped);
});

/* ── POST /applications ───────────────────────────────────────────────────── */
router.post("/applications", validate({ body: CreateApplicationBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { jobId, candidateId, stage, notes } = req.body;
  /* Manual placement: create the application directly at a target stage without
   * firing the create-time Screening/ICP agents (used by the "Move to stage
   * without automation" flow for candidates who already progressed off-platform). */
  const skipAutomation = req.body.skipAutomation === true;

  /* Tenant-scope both foreign keys before insert. Without this check a
   * caller could POST any jobId/candidateId combination and create a
   * cross-tenant application row whose `mapApplication()` response would
   * then leak the foreign job + candidate data. Return 404 (not 403) to
   * avoid distinguishing "exists but wrong tenant" from "doesn't exist". */
  const allowed = await getDataScopeTenantIds(user); // null = platform_admin
  const [job] = await db.select({ id: jobsTable.id, tenantId: jobsTable.tenantId, status: jobsTable.status })
    .from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job || (allowed && !allowed.includes(job.tenantId ?? ""))) {
    res.status(404).json({ error: "Job not found" }); return;
  }
  /* Recruiter ownership ceiling: a plain recruiter may only create applications
     for a requisition assigned to them. */
  if (user.role === "recruiter") {
    const assignedJobIds = await getRecruiterAssignedJobIds(user);
    if (!assignedJobIds.includes(jobId)) { res.status(404).json({ error: "Job not found" }); return; }
  }
  // A requisition must clear approval before candidates can be added to its
  // pipeline — recruiters cannot act on a draft / pending / returned work order.
  // Runs after the ownership check so an unauthorized recruiter still gets 404.
  if (!assertJobApproved(res, job.status)) return;
  const [cand] = await db.select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId, email: candidatesTable.email, dataErasedAt: (candidatesTable as any).dataErasedAt, doNotContact: (candidatesTable as any).doNotContact })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!cand || (allowed && !allowed.includes(cand.tenantId ?? ""))) {
    res.status(404).json({ error: "Candidate not found" }); return;
  }
  if ((cand as any).dataErasedAt) {
    res.status(410).json({ error: "Candidate data has been erased" }); return;
  }
  if ((cand as any).doNotContact) {
    res.status(409).json({ error: "Candidate has opted out of contact" }); return;
  }

  /* Contact-email guardrail (NON-overridable): mirror the PUT stage-transition
     refusal on direct create — a candidate cannot be inserted straight into the
     Outreach Queued ("shortlisted") column with no real email on file, even under
     skipAutomation. Every downstream send would bounce, so refuse before insert
     rather than land a queued-but-unmessageable card. */
  if (stage === "shortlisted" && !isRealEmail((cand as any).email)) {
    res.status(422).json({
      error: "Can't add to Shortlisted: this candidate has no email address on file. Add or enrich an email first.",
      code: "NO_CONTACT_EMAIL",
      recoverable: true,
    });
    return;
  }

  /* Derive the owning tenant from the validated records — NOT the caller — so a
     parent admin creating an application for a child tenant writes the row into
     the CHILD tenant. Job and candidate must belong to the same tenant. */
  const tenantId = job.tenantId ?? cand.tenantId;
  if (!tenantId || (job.tenantId && cand.tenantId && job.tenantId !== cand.tenantId)) {
    res.status(400).json({ error: "Job and candidate belong to different tenants" }); return;
  }

  /* Sourcing-origin attribution: LINX push to this tenant → L3XY-sourced
     (fee-eligible on hire); otherwise the customer's own candidate (manual). */
  const origin = await recruiterLinkOrigin({
    candidateId,
    tenantId,
    via: "applications_api",
    actorId: user?.id ?? null,
  });

  const [app] = await db.insert(applicationsTable).values({
    tenantId,
    jobId, candidateId,
    stage: stage || "applied",
    notes,
    ...origin,
  }).returning();

  const result = await mapApplication(app);
  res.status(201).json(result);

  void logCandidateEvent({
    candidateId: app.candidateId,
    jobId: app.jobId ?? null,
    tenantId: app.tenantId ?? "",
    applicationId: app.id,
    eventType: "JOB_MATCHED",
    actorType: actorTypeFromRole(user?.role),
    actorId: user?.id ?? null,
    source: "recruiter_action",
    metadata: { stage: app.stage },
  });

  if (skipAutomation) {
    logger.info({ candidateId, jobId, stage: app.stage }, "Application created via manual placement → skipping Screening/ICP automation");
    return;
  }

  logger.info({ candidateId, jobId }, "Application created → triggering Screening agent");
  const icpExists = jobId ? await db.select().from(icpTable).where(eq(icpTable.jobId, jobId)).limit(1) : [];

  orchestrator.triggerAgent("screening", { candidateId, jobId: jobId ?? undefined, applicationId: app.id }, "orchestrator")
    .then(run => {
      if (run.status === "completed" && !icpExists.length && jobId) {
        logger.info({ jobId }, "No ICP found for job → triggering ICP agent");
        orchestrator.triggerAgent("icp", { jobId }, "orchestrator")
          .catch(err => logger.error({ err, jobId }, "ICP agent failed after screening"));
      }
    })
    .catch(err => logger.error({ err, candidateId }, "Screening agent failed after application"));
});

/* ── GET /applications/:applicationId ────────────────────────────────────── */
router.get("/applications/:applicationId", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [a] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, req.params.applicationId)).limit(1);
  /* Return 404 (not 403) on cross-tenant access so callers cannot enumerate
     valid IDs by status code differences. */
  if (!a) { res.status(404).json({ error: "Not found" }); return; }
  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(a.tenantId ?? "")) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }
  /* Recruiter ownership ceiling — 404 (existence-disclosure posture) when the
     application's requisition is not assigned to the recruiter. */
  if (user.role === "recruiter") {
    const assignedJobIds = await getRecruiterAssignedJobIds(user);
    if (!a.jobId || !assignedJobIds.includes(a.jobId)) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }

  res.json(await mapApplication(a));
});

/* ── PUT /applications/:applicationId ────────────────────────────────────── */
router.put("/applications/:applicationId", validate({ body: UpdateApplicationBody }), async (req, res) => {
  const user = await getCallerUser(req);
  /* Mandatory auth — destructive mutation on hiring pipeline. */
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [existing] = await db.select({ tenantId: applicationsTable.tenantId, jobId: applicationsTable.jobId })
    .from(applicationsTable).where(eq(applicationsTable.id, req.params.applicationId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(existing.tenantId ?? "")) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }
  /* Recruiter ownership ceiling — a plain recruiter may only mutate applications
     for a requisition assigned to them. */
  if (user.role === "recruiter") {
    const assignedJobIds = await getRecruiterAssignedJobIds(user);
    if (!existing.jobId || !assignedJobIds.includes(existing.jobId)) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }

  // Stage transition gating: enforce a logical order so a candidate
  // cannot jump straight to "offer" or "hired" without prior stages.
  // Also remember whether THIS request is the one transitioning the
  // application to "rejected" so we can fire the candidate notification
  // exactly once.
  let transitioningToRejected = false;
  let priorStageBeforeReject: string | null = null;
  let transitioningToScreening = false;
  let transitioningToVerification = false;
  let transitioningToOutreach = false;
  let highIntentStageMove: string | null = null;
  /* Captured inside the stage-gating block so the choke-point (which needs a
   * NOT-NULL candidate id for the STAGE_CHANGED event) can be called after it. */
  let candidateId: string | null = null;
  /* Explicit manual placement — bypass ordering gates AND suppress every
   * stage-entry automation (agents, invites, rejection email). See schema. */
  const skipAutomation = req.body.skipAutomation === true;
  if (req.body.stage) {
    const [current] = await db.select().from(applicationsTable)
      .where(eq(applicationsTable.id, req.params.applicationId)).limit(1);
    const currentStage = current?.stage ?? "applied";
    candidateId = current?.candidateId ?? null;
    const target = req.body.stage as string;

    /* High-intent manual moves (into Assessment or Offer) should ping the
     * assigned recruiter so they aren't blindsided by a hiring manager
     * advancing the role. Captured here (before the write) and fired after. */
    if ((target === "assessment" || target === "offer") && target !== currentStage) {
      highIntentStageMove = target;
    }

    if (target === "rejected" && currentStage !== "rejected") {
      transitioningToRejected = true;
      priorStageBeforeReject = currentStage;
    }

    /* Moving a candidate INTO the Screening stage must compute their AI match
     * score — without this, application-based candidates land in Screening with
     * no score (the create-time screening only fires on POST /applications, so a
     * candidate advanced here manually was never scored). */
    if (target === "screening" && currentStage !== "screening") {
      transitioningToScreening = true;
    }

    /* Moving a candidate INTO the Verify stage must run the Verification Agent
     * so the card shows a real verdict + flags + notes. Manual/applied
     * candidates have no sourced_candidates row, so the sourced send_to_verify
     * path never fired for them — without this they'd land in Verify untouched. */
    if (target === "verification" && currentStage !== "verification") {
      transitioningToVerification = true;
    }

    /* Moving a candidate INTO the Outreach Queued ("shortlisted") stage must run
     * the Outreach Agent so a first-touch email DRAFT is generated and held for
     * recruiter approval. Without this, advancing a candidate here only relabels
     * the stage — no draft is created and no email is ever queued/sent, which is
     * exactly what recruiters reported ("moved to Outreach Queued, no draft, no
     * email"). The agent enforces the verify→outreach gate itself (it skips
     * candidates that have not passed verification). */
    if (target === "shortlisted" && currentStage !== "shortlisted") {
      transitioningToOutreach = true;
    }

    /* Contact-email guardrail (NON-overridable): a candidate cannot enter the
     * Outreach Queued ("shortlisted") column with no real email on file — the
     * column means "ready to be messaged", and every downstream send would
     * bounce. Unlike the verify→outreach gate (which an explicit recruiter drag
     * may override), no manual action can conjure an address, so this refusal
     * holds even for skipAutomation manual placements. Refuse BEFORE the stage
     * write so the card never lands in a queued-but-unmessageable state; the
     * recruiter's remedy is to add or enrich an email first. */
    if (transitioningToOutreach && current?.candidateId) {
      const [emailCand] = await db.select({ email: candidatesTable.email })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, current.candidateId))
        .limit(1);
      if (!isRealEmail(emailCand?.email)) {
        res.status(422).json({
          error: "Can't move to Shortlisted: this candidate has no email address on file. Add or enrich an email first.",
          code: "NO_CONTACT_EMAIL",
          recoverable: true,
        });
        return;
      }
    }

    // Allow rejection from any stage; allow no-op. Ordering gates are skipped
    // entirely for an explicit manual placement (skipAutomation): the recruiter
    // is deliberately reflecting an off-platform outcome and the linear pipeline
    // prerequisites (completed interview, offer-before-hired, etc.) don't apply.
    if (!skipAutomation && target !== "rejected" && target !== currentStage) {
      // Block jump to "offer" without a completed interview — UNLESS the
      // recruiter explicitly overrides. The override is the recovery path for
      // the dead-end where a candidate's interview session was deleted, errored
      // out, or never recorded a "completed" status: without it such candidates
      // could never reach Offer and were silently stuck. The override is a
      // deliberate human action (recorded in logs); the gate still applies to
      // ordinary drag-to-Offer moves.
      const overrideInterviewGate = req.body.overrideInterviewGate === true;
      if (target === "offer" && current?.candidateId && !overrideInterviewGate) {
        const [completed] = await db.select({ id: interviewSessionsTable.id })
          .from(interviewSessionsTable)
          .where(and(
            eq(interviewSessionsTable.candidateId, current.candidateId),
            eq(interviewSessionsTable.status, "completed"),
          )).limit(1);
        if (!completed) {
          res.status(400).json({
            error: "Cannot move to Offer: candidate has not completed an interview yet.",
            code: "INTERVIEW_REQUIRED",
            recoverable: true,
          });
          return;
        }
      } else if (target === "offer" && overrideInterviewGate) {
        logger.warn(
          { applicationId: req.params.applicationId, candidateId: current?.candidateId, userId: user?.id },
          "Offer interview-gate overridden by recruiter (interview-deleted recovery path)",
        );
      }
      // Block jump to "hired" unless prior stage was in the offer funnel
      const validHiredFromStages = ["offer", "offer_recommended", "offer_extended", "offer_accepted"];
      if (target === "hired" && !validHiredFromStages.includes(currentStage)) {
        res.status(400).json({ error: "Cannot move to Hired: candidate must be in an Offer stage first." });
        return;
      }
      // Block jump to "started" unless prior stage was "hired"
      if (target === "started" && currentStage !== "hired") {
        res.status(400).json({ error: "Cannot move to Started: candidate must be in Hired stage first." });
        return;
      }
    }
  }

  let a: typeof applicationsTable.$inferSelect | undefined;
  if (req.body.stage && candidateId) {
    /* ── Canonical stage move ── route BOTH the applications.stage write and the
     * sourced_candidates mirror through the choke-point so stage + sourced mirror
     * + candidate_events(STAGE_CHANGED) + audit_logs pointer commit ATOMICALLY.
     * The two stage values are now structurally incapable of desyncing. Every
     * downstream hook/event below still fires unchanged — but only AFTER this
     * transaction commits (so no rejection email / agent enrolment fires on a
     * move that rolled back). */
    const { stage: _stage, ...applicationPatch } = req.body as Record<string, unknown>;
    // Resolve the linked sourced row (if any) up front so its rawData.stage is
    // updated inside the same transaction, not as a fire-and-forget afterthought.
    const [sc] = await db.select({ id: sourcedCandidatesTable.id })
      .from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.normalizedCandidateId, candidateId))
      .limit(1);
    try {
      await changeCandidateStage({
        tenantId: existing.tenantId ?? "",
        candidateId,
        jobId: existing.jobId ?? "",
        to: req.body.stage as string,
        actor: { type: "user", role: user.role, id: user.id ?? null },
        source: "recruiter_action",
        applicationId: req.params.applicationId,
        applicationPatch,
        sourcedId: sc?.id ?? null,
        sourcedRawDataPatch: sc ? { jobId: existing.jobId } : undefined,
      });
    } catch (err) {
      logger.error({ err, applicationId: req.params.applicationId }, "Stage change transaction failed — rolled back (stage/mirror/event/audit)");
      res.status(500).json({ error: "Failed to update stage" });
      return;
    }
    [a] = await db.select().from(applicationsTable)
      .where(eq(applicationsTable.id, req.params.applicationId)).limit(1);
  } else {
    /* No stage in the body (plain column update) OR the application has no
     * canonical candidate id to anchor a STAGE_CHANGED event.
     * stage-write-exempt: candidate-less rows can't be audited (candidate_events
     * .candidateId is NOT NULL); a no-stage PUT isn't a pipeline move at all. */
    [a] = await db.update(applicationsTable)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(applicationsTable.id, req.params.applicationId))
      .returning();
  }
  if (!a) { res.status(404).json({ error: "Not found" }); return; }

  /* Emit a candidate lifecycle event for every meaningful stage transition. */
  if (req.body.stage && a.candidateId) {
    const stageToEvent: Record<string, string> = {
      shortlisted:              "RECRUITER_SHORTLISTED",
      hm_review:                "SUBMITTED_TO_HIRING_MANAGER",
      offer_recommended:        "OFFER_RECOMMENDED",
      rejected:                 "REJECTED",
      withdrawn:                "WITHDRAWN",
      interview:                "INTERVIEW_INVITED",
      interview_scheduled:      "HIRING_MANAGER_INTERVIEW_SCHEDULED",
      interview_completed:      "HIRING_MANAGER_INTERVIEW_COMPLETED",
    };
    const evType = stageToEvent[req.body.stage as string];
    if (evType) {
      void logCandidateEvent({
        candidateId: a.candidateId,
        jobId: a.jobId ?? null,
        tenantId: a.tenantId ?? "",
        applicationId: a.id,
        eventType: evType as any,
        actorType: actorTypeFromRole(user?.role),
        actorId: user?.id ?? null,
        source: "recruiter_action",
        metadata: { fromStage: req.body.stage },
      });
    }
  }

  /* Auto-capture terminal outcomes — when an application reaches a terminal
   * stage we record (idempotently) its outcome on candidate_outcomes so the
   * learning loop has a label without the recruiter logging it by hand.
   * Fire-and-forget so it never blocks or rolls back the stage write. */
  if (req.body.stage && a.candidateId && a.jobId) {
    const terminalMap: Record<string, "hired" | "rejected" | "withdrawn" | "ghosted"> = {
      hired: "hired",
      rejected: "rejected",
      withdrawn: "withdrawn",
      no_show: "ghosted",
    };
    const terminalOutcome = terminalMap[req.body.stage as string];
    if (terminalOutcome) {
      (async () => {
        try {
          const { recordTerminalOutcome } = await import("../lib/record-terminal-outcome.js");
          await recordTerminalOutcome({
            tenantId: a.tenantId,
            applicationId: a.id,
            candidateId: a.candidateId,
            jobId: a.jobId,
            outcome: terminalOutcome,
            source: `auto:applications:${terminalOutcome}`,
          });
        } catch (err) {
          logger.warn({ err }, "Failed to auto-capture terminal outcome (non-fatal)");
        }
      })();
    }
  }

  /* High-intent stage-move alert (Assessment / Offer) — fire-and-forget so it
   * never blocks or rolls back the stage write. Notifies the assigned recruiter
   * (unless they made the move themselves). */
  if (highIntentStageMove && a.candidateId) {
    (async () => {
      try {
        const { notifyRecruiterOfStageMove } = await import("../lib/recruiter-reply-notify.js");
        await notifyRecruiterOfStageMove({
          tenantId: a.tenantId,
          jobId: a.jobId,
          candidateId: a.candidateId,
          toStage: highIntentStageMove!,
          movedByUserId: user?.id ?? null,
        });
      } catch (err) {
        logger.warn({ err }, "Failed to notify recruiter of high-intent stage move (non-fatal)");
      }
    })();
  }

  /* When the application has just transitioned to "rejected", persist a
   * `candidate_rejections` audit row AND fire the candidate-facing email.
   * Best-effort and fire-and-forget so it never blocks the response or
   * rolls back the stage update. The reason / notes can be supplied by
   * the caller (Reject button dialog) — we accept either flat fields
   * (`rejectionReason`, `rejectionNotes`) on the request body. */
  if (transitioningToRejected && a.candidateId) {
    const rejectionReason: string | null = req.body.rejectionReason ?? req.body.rejection_reason ?? null;
    const rejectionNotes: string | null = req.body.rejectionNotes ?? req.body.rejection_notes ?? null;
    (async () => {
      try {
        const { recordRejection } = await import("../lib/record-rejection.js");
        await recordRejection({
          tenantId: a.tenantId,
          jobId: a.jobId,
          applicationId: a.id,
          candidateId: a.candidateId,
          rejectedByUserId: user?.id ?? null,
          rejectedByRole: user?.role === "hiring_manager" ? "hiring_manager" : "recruiter",
          reason: rejectionReason,
          notes: rejectionNotes,
          fromStage: priorStageBeforeReject,
          sendEmail: !skipAutomation,
        });
      } catch (err) {
        logger.warn({ err }, "Failed to record/email candidate rejection (non-fatal)");
      }
      /* Governance attestation: write final_decision through the
       * enforcement service so the DB-enforced human-finality split
       * (T010 / migration 0016) holds for legacy reject UIs too.
       * Best-effort: failure here MUST NOT roll back the candidate
       * notification or the stage write — surface in logs. The attestation
       * text uses the standardised wording per the design directive:
       *   "I reviewed AI recs and role-relevant info before confirming".
       * Recruiters will iterate to richer attestation in the dedicated
       * human-decision endpoint as the new UI ships. */
      try {
        const { applyHumanDecision } = await import("../lib/governance/decision-enforcement.js");
        await applyHumanDecision({
          applicationId: a.id,
          finalDecision: "human_reject",
          decidedByUserId: user?.id ?? "system_unknown_user",
          decidedByRole: (user?.role as any) ?? "recruiter",
          attestation:
            "I reviewed the AI recommendations and role-relevant candidate information before confirming this action (recorded via legacy reject UI).",
          reason: [rejectionReason, rejectionNotes].filter(Boolean).join(" — ") || null,
        });
      } catch (err) {
        logger.warn({ err }, "Failed to record governance final_decision (non-fatal)");
      }
    })();
  }

  /* The sourced_candidates rawData.stage mirror is now written ATOMICALLY inside
   * changeCandidateStage above (sourcedId path), so the two stage values can
   * never desync. The former fire-and-forget mirror block was removed. */

  // Auto-invite on meaningful stage advances (suppressed for manual placement)
  const autoInviteStages = ["shortlisted", "interview_scheduled", "phone_screen", "assessment", "offer"];
  if (!skipAutomation && req.body.stage && autoInviteStages.includes(req.body.stage)) {
    ensureCandidateUser(a.candidateId, a.tenantId)
      .then(userId => userId ? generateInviteToken(a.candidateId, userId, a.tenantId) : null)
      .then(token => token && logger.info({ candidateId: a.candidateId, stage: req.body.stage, token }, "Auto-invite generated on stage advance"))
      .catch(err => logger.warn({ err }, "Auto-invite failed on stage advance (non-fatal)"));
  }

  /* Fire the Screening agent when the candidate just entered Screening so a
   * match score is computed and surfaced on the kanban card. Fire-and-forget so
   * it never blocks or rolls back the stage write. */
  if (transitioningToScreening && a.candidateId && !skipAutomation) {
    logger.info({ applicationId: a.id, candidateId: a.candidateId, jobId: a.jobId }, "Application advanced to Screening → triggering Screening agent");
    orchestrator.triggerAgent("screening", { candidateId: a.candidateId, jobId: a.jobId ?? undefined, applicationId: a.id }, "orchestrator")
      .catch(err => logger.error({ err, candidateId: a.candidateId }, "Screening agent failed after advance to screening"));
  }

  /* Fire the Verification Agent when the candidate just entered Verify so the
   * card shows a real verdict + flags + notes. Application-based (manual/applied)
   * candidates have no sourced row, so the sourced send_to_verify path never ran
   * for them. Fire-and-forget so it never blocks or rolls back the stage write. */
  if (transitioningToVerification && a.candidateId && !skipAutomation) {
    logger.info({ applicationId: a.id, candidateId: a.candidateId, jobId: a.jobId }, "Application advanced to Verify → triggering Verification agent");
    import("../lib/run-verification.js")
      .then(({ runCandidateVerification }) => runCandidateVerification({ candidateId: a.candidateId, tenantId: a.tenantId }))
      .catch(err => logger.error({ err, candidateId: a.candidateId }, "Verification agent failed after advance to verification"));
  }

  /* Fire the Outreach Agent when the candidate just entered Outreach Queued so a
   * first-touch email draft is generated and held for recruiter approval (it
   * surfaces under Outreach → Approvals). Fire-and-forget so it never blocks or
   * rolls back the stage write. Because dragging a candidate here is an explicit
   * recruiter/admin decision, we pass manualOverride so the agent generates the
   * draft even when the candidate has not cleared verification (e.g. the
   * Verification Agent returned "pending / needs review"). The draft is still
   * held for approval, and the agent won't regenerate one when it already
   * exists. */
  if (transitioningToOutreach && a.candidateId && !skipAutomation) {
    logger.info({ applicationId: a.id, candidateId: a.candidateId, jobId: a.jobId }, "Application advanced to Outreach Queued → triggering Outreach agent (manual recruiter override)");
    orchestrator.triggerAgent("outreach", { candidateId: a.candidateId, jobId: a.jobId ?? undefined, passedCandidateIds: [a.candidateId], manualOverride: true }, "orchestrator")
      .catch(err => logger.error({ err, candidateId: a.candidateId }, "Outreach agent failed after advance to outreach"));
  }

  res.json(await mapApplication(a));
});

export default router;
