import { Router, type Request, type Response } from "express";
import { workflowScreeningReadiness } from "../lib/workflow-profile-screening";
import { z } from "zod";
import {
  DraftJobWorkflowJourneyBody,
  EnrollCandidateWorkflowBody,
  ControlCandidateWorkflowBody,
  RecordCandidateWorkflowEvidenceBody,
  CorrectCandidateWorkflowDecisionBody,
  LaunchCandidateWorkflowActionBody,
  ControlWorkflowLivePilotBody,
  ResolveWorkflowIdentityBody,
  RecoverCandidateWorkflowActionBody,
  ControlWorkflowFollowUpBody,
  type JobWorkflowState,
  type InterviewPath,
} from "@workspace/api-zod";
import { and, eq, inArray, or, desc, sql } from "drizzle-orm";
import {
  db,
  controlDb,
  jobsTable,
  usersTable,
  candidatesTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import {
  getDataScopeTenantIds,
  getAllowedTenantIds,
  recruiterIsAssignedToJob,
} from "../lib/tenantUtils";
import { validate } from "../middlewares/validate";
import { resolveWorkflowIdentity } from "../lib/workflow-identity-resolution";
import { correctWorkflowDecision } from "../lib/workflow-decision-corrections";
import { readWorkflowRecovery, recoverWorkflowAction } from "../lib/workflow-action-recovery";
import {
  canControlWorkflowPilot,
  controlWorkflowPilot,
  readWorkflowPilot,
} from "../lib/workflow-live-pilot";
import {
  readRuntimeObservations,
  projectRuntimeEvidence,
  runtimeEvidenceBlockedReason,
} from "../lib/workflow-runtime-evidence";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "./candidates";
import { buildWorkflowShadow } from "../lib/workflow-shadow";
import { safeOfferSteps } from "../lib/controlled-offer-view";
import {
  readBrief,
  approvedJob,
  draftJourney,
  approveJourney,
  enrollWorkflow,
  controlWorkflow,
  recordWorkflowEvidence,
  WorkflowConflict,
  fingerprint,
  type WorkflowScope,
} from "../lib/recruiting-workflows";

const router = Router();
const STAFF = [
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
  "interviewer",
];
const APPROVERS = ["platform_admin", "tenant_admin", "recruiter_admin", "hiring_manager"];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const draftBody = DraftJobWorkflowJourneyBody.extend({ expectedBriefHash: hash }).strict();
const enrollmentBody = EnrollCandidateWorkflowBody.extend({
  expectedBriefHash: hash,
  journeyId: z.string().min(1),
  candidateId: z.string().min(1),
}).strict();
const controlBody = ControlCandidateWorkflowBody.strict();
const evidenceBody = RecordCandidateWorkflowEvidenceBody.extend({
  stepKey: z.string().min(1),
  evidence: z.string().trim().min(1).max(4000),
}).strict();
const launchBody = LaunchCandidateWorkflowActionBody.strict();
const followUpBody = ControlWorkflowFollowUpBody.extend({
  subject: z.string().trim().min(1).max(160).optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  scheduledAt: z.string().datetime().optional(),
}).strict();

export async function gateJobAccess(req: Request, res: Response, write = false, approval = false) {
  const id = getAuthUserId(req);
  if (!id) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user || user.status !== "active") {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (
    !STAFF.includes(user.role) ||
    (write && user.role === "interviewer") ||
    (approval && !APPROVERS.includes(user.role))
  ) {
    res.status(403).json({ error: "Role does not have authority for this operation" });
    return null;
  }
  const jobId = String(req.params.jobId);
  try {
    return await resolveWorkflowJobAccess(user, jobId);
  } catch (error) {
    if (!(error instanceof WorkflowConflict)) throw error;
    res.status(error.status).json({ error: error.message });
    return null;
  }
}

/** Shared job/recruiter ceiling for the assigned-offer inbox and workflow routes. */
export async function resolveWorkflowJobAccess(
  user: typeof usersTable.$inferSelect,
  jobId: string,
) {
  if (user.status !== "active" || !STAFF.includes(user.role))
    throw new WorkflowConflict("Role does not have authority for this operation", 403);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) throw new WorkflowConflict("Not found", 404);
  const allowed = await getDataScopeTenantIds(user);
  if (
    (allowed !== null && !allowed.includes(job.tenantId)) ||
    (user.role === "recruiter" && !(await recruiterIsAssignedToJob(user.id, job))) ||
    (user.role === "hiring_manager" && job.assignedHiringManagerId !== user.id)
  ) {
    throw new WorkflowConflict("Not found", 404);
  }
  return {
    job,
    user,
    allowed: await getAllowedTenantIds(user),
    scope: {
      jobId,
      tenantId: job.tenantId,
      actorId: user.id,
      actorName: user.name,
      canApprove: APPROVERS.includes(user.role),
      canEdit: user.role !== "interviewer",
    } satisfies WorkflowScope,
  };
}
type Gate = NonNullable<Awaited<ReturnType<typeof gateJobAccess>>>;
type Handle = Parameters<typeof readBrief>[0];

export async function eligibleCandidates(handle: Handle, gate: Gate) {
  const rows = await handle
    .select()
    .from(candidatesTable)
    .where(
      and(
        gate.allowed === null
          ? undefined
          : or(
              inArray(candidatesTable.tenantId, gate.allowed),
              eq(candidatesTable.pool, "platform"),
            ),
        sql`EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=${candidatesTable.id} AND a.job_id=${gate.job.id})`,
      ),
    );
  const hardFiltered = applyCandidateHardExclusions(rows);
  return applyCandidatePrivacyFilter(
    hardFiltered,
    gate.user.role === "platform_admin" ? null : gate.job.tenantId,
  );
}

export async function candidateAllowed(handle: Handle, gate: Gate, candidateId: string) {
  // Authenticated parent job + current row/privacy seal, not caller-supplied linkage.
  return (await eligibleCandidates(handle, gate)).some((candidate) => candidate.id === candidateId);
}

const handleError = (res: Response, error: unknown) => {
  if (error instanceof WorkflowConflict) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
};

async function readWorkflowSnapshot(gate: Gate) {
  const current = await readBrief(db, gate.scope);
  const journeyRows = await db
    .select()
    .from(journeys)
    .where(and(eq(journeys.tenantId, gate.job.tenantId), eq(journeys.jobId, gate.job.id)))
    .orderBy(desc(journeys.version));
  const candidateRows = await eligibleCandidates(db, gate);
  const names = new Map(candidateRows.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
  const screeningReadiness = new Map(
    candidateRows.map((c) => [c.id, workflowScreeningReadiness(c)]),
  );
  const identityOwners = new Map(candidateRows.map((c) => [c.id, c.tenantId]));
  const workflowRows = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenantId, gate.job.tenantId), eq(workflows.jobId, gate.job.id)))
    .orderBy(desc(workflows.createdAt));
  const visibleWorkflows = workflowRows.filter((w) => names.has(w.candidateId));
  const visibleIds = new Set(visibleWorkflows.map((w) => w.id));
  const hashes = new Map(journeyRows.map((j) => [j.id, j.briefHash]));
  const runtime = await readRuntimeObservations(
    db,
    gate.job.id,
    gate.job.tenantId,
    candidateRows.filter((c) => visibleWorkflows.some((w) => w.candidateId === c.id)),
  );
  const eventRows = await db
    .select()
    .from(events)
    .where(and(eq(events.tenantId, gate.job.tenantId), eq(events.jobId, gate.job.id)))
    .orderBy(desc(events.createdAt))
    .limit(200);
  const pilotStates = new Map(
    await Promise.all(
      visibleWorkflows.map(
        async (wf) =>
          [wf.id, await readWorkflowPilot(controlDb, gate.scope, wf, current.job.title)] as const,
      ),
    ),
  );
  const recoveryStates = new Map(
    await Promise.all(
      visibleWorkflows.map(
        async (wf) => [wf.id, await readWorkflowRecovery(controlDb, gate.scope, wf)] as const,
      ),
    ),
  );
  const state: JobWorkflowState = {
    canControlLivePilot: canControlWorkflowPilot(gate.user.role),
    briefHash: current.hash,
    autonomyExecutionEnabled: false,
    canEdit: gate.user.role !== "interviewer",
    canApprove: gate.scope.canApprove,
    jobApproved: approvedJob(current.job.status),
    journeys: journeyRows.map(
      ({
        brief: _brief,
        approvedAt: _at,
        createdAt: _created,
        tenantId: _tenant,
        jobId: _job,
        ...row
      }) => ({
        ...row,
        interviewPath: row.interviewPath as InterviewPath,
        stale: row.briefHash !== current.hash,
      }),
    ),
    workflows: visibleWorkflows.map(
      ({
        tenantId: _tenant,
        jobId: _job,
        createdById: _by,
        createdAt: _at,
        updatedAt: _updated,
        ...row
      }) => ({
        ...row,
        livePilot: pilotStates.get(row.id),
        steps: safeOfferSteps(row.steps, gate.scope.canEdit !== false),
        recovery: recoveryStates.get(row.id),
        identityResolutionAllowed:
          gate.scope.canApprove &&
          (gate.allowed === null || gate.allowed.includes(identityOwners.get(row.candidateId)!)),
        candidateName: names.get(row.candidateId)!,
        screeningReadiness: screeningReadiness.get(row.candidateId),
        stale: hashes.get(row.journeyId) !== current.hash,
        runtimeEvidenceBlockedReason: runtimeEvidenceBlockedReason(
          {
            ...row,
            createdAt: _at,
            updatedAt: _updated,
            tenantId: _tenant,
            jobId: _job,
            createdById: _by,
          },
          approvedJob(current.job.status),
          journeyRows.some(
            (j) =>
              j.id === row.journeyId &&
              j.version === row.journeyVersion &&
              j.status === "approved" &&
              j.briefHash === current.hash,
          ),
        ),
        runtimeEvidence: projectRuntimeEvidence(
          {
            ...row,
            createdAt: _at,
            updatedAt: _updated,
            tenantId: _tenant,
            jobId: _job,
            createdById: _by,
          },
          runtime,
          runtimeEvidenceBlockedReason(
            {
              ...row,
              createdAt: _at,
              updatedAt: _updated,
              tenantId: _tenant,
              jobId: _job,
              createdById: _by,
            },
            approvedJob(current.job.status),
            journeyRows.some(
              (j) =>
                j.id === row.journeyId &&
                j.version === row.journeyVersion &&
                j.status === "approved" &&
                j.briefHash === current.hash,
            ),
          ),
        ).map((entry) => ({ ...entry, occurredAt: new Date(entry.occurredAt) })),
      }),
    ),
    candidates: candidateRows.map((c) => ({
      id: c.id,
      name: names.get(c.id)!,
      screeningReadiness: screeningReadiness.get(c.id),
    })),
    events: eventRows
      .filter((e) => !e.workflowId || visibleIds.has(e.workflowId))
      .map((e) => ({
        id: e.id,
        workflowId: e.workflowId,
        journeyId: e.journeyId,
        action: e.action,
        actorId: e.actorId,
        note:
          e.action === "workflow.live_screening_pilot"
            ? "Pilot authority updated. One selected assessment only; this control did not launch an agent."
            : e.note,
        createdAt: e.createdAt,
      })),
  };
  return { state, job: current.job };
}

router.get("/jobs/:jobId/workflow-state", async (req, res) => {
  const gate = await gateJobAccess(req, res);
  if (!gate) return;
  res.json((await readWorkflowSnapshot(gate)).state);
});

router.get("/jobs/:jobId/workflow-shadow", async (req, res) => {
  const gate = await gateJobAccess(req, res);
  if (!gate) return;
  const { state, job } = await readWorkflowSnapshot(gate);
  res.json(buildWorkflowShadow(job, state));
});

router.post("/jobs/:jobId/workflow-journeys", validate({ body: draftBody }), async (req, res) => {
  const gate = await gateJobAccess(req, res, true);
  if (!gate) return;
  try {
    res.json(await draftJourney(gate.scope, req.body));
  } catch (error) {
    handleError(res, error);
  }
});
router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/recover",
  validate({ body: RecoverCandidateWorkflowActionBody.strict() }),
  async (req, res): Promise<void> => {
    const gate = await gateJobAccess(req, res, true, true);
    if (!gate) return;
    try {
      res.json(
        await recoverWorkflowAction(gate.scope, String(req.params.workflowId), req.body, (tx, id) =>
          candidateAllowed(tx, gate, id),
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/live-pilot",
  validate({ body: ControlWorkflowLivePilotBody.strict() }),
  async (req, res): Promise<void> => {
    const gate = await gateJobAccess(req, res, true, true);
    if (!gate) return;
    try {
      const result = await controlWorkflowPilot(
        gate.scope,
        String(req.params.workflowId),
        req.body,
        (tx, id) => candidateAllowed(tx, gate, id),
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/identity-resolution",
  validate({
    body: ResolveWorkflowIdentityBody.extend({
      // JSON carries an ISO string; Orval's generated z.date() expects an in-memory Date.
      recordUpdatedAt: z
        .string()
        .datetime()
        .transform((value) => new Date(value)),
    }).strict(),
  }),
  async (req, res): Promise<void> => {
    const gate = await gateJobAccess(req, res, true, true);
    if (!gate) return;
    try {
      res.json(
        await resolveWorkflowIdentity(
          gate.scope,
          String(req.params.workflowId),
          req.body,
          (tx, id) => candidateAllowed(tx, gate, id),
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/jobs/:jobId/workflow-journeys/:journeyId/approve",
  validate({ body: draftBody }),
  async (req, res) => {
    const gate = await gateJobAccess(req, res, true, true);
    if (!gate) return;
    try {
      res.json(await approveJourney(gate.scope, String(req.params.journeyId), req.body));
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.post(
  "/jobs/:jobId/candidate-workflows",
  validate({ body: enrollmentBody }),
  async (req, res) => {
    const gate = await gateJobAccess(req, res, true);
    if (!gate) return;
    try {
      res.json(
        await enrollWorkflow(gate.scope, req.body, (tx, id) => candidateAllowed(tx, gate, id)),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/control",
  validate({ body: controlBody }),
  async (req, res) => {
    const gate = await gateJobAccess(req, res, true);
    if (!gate) return;
    try {
      res.json(
        await controlWorkflow(gate.scope, String(req.params.workflowId), req.body, (tx, id) =>
          candidateAllowed(tx, gate, id),
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/execute",
  validate({ body: launchBody }),
  async (req, res) => {
    const gate = await gateJobAccess(req, res, true);
    if (!gate) return;
    try {
      const [wf] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.id, String(req.params.workflowId)),
            eq(workflows.jobId, gate.job.id),
            eq(workflows.tenantId, gate.job.tenantId),
          ),
        );
      if (!wf || !(await candidateAllowed(db, gate, wf.candidateId))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const next = wf.steps.find((step) => step.status !== "completed");
      const agents = {
        screening: "screening",
        verification: "verification",
        engagement: "outreach",
        ai_interview: "interview",
      } as const;
      const agentId = next && agents[next.key as keyof typeof agents];
      if (!next || !agentId)
        throw new WorkflowConflict("The next step requires human review or coordination.", 409);
      // No caller-supplied candidate IDs, provider choices or arbitrary agent input.
      const input = { jobId: gate.job.id, candidateId: wf.candidateId };
      const { orchestrator } = await import("../lib/agents/orchestrator");
      const run = await orchestrator.triggerAgent(agentId, input, "user", {
        workflow: {
          scope: gate.scope,
          input: {
            workflowId: wf.id,
            candidateId: wf.candidateId,
            journeyId: wf.journeyId,
            journeyVersion: wf.journeyVersion,
            expectedRevision: req.body.expectedRevision,
            idempotencyKey: req.body.idempotencyKey,
            stepKey: next.key,
            actionKind: "agent",
            payloadHash: fingerprint({ agentId, input }),
          },
          candidateAllowed: (tx, id) => candidateAllowed(tx, gate, id),
        },
      });
      res.json({ runId: run.id, status: run.status });
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/decision-correction",
  validate({ body: CorrectCandidateWorkflowDecisionBody.strict() }),
  async (req, res) => {
    const gate = await gateJobAccess(req, res, true);
    if (!gate) return;
    try {
      res.json(
        await correctWorkflowDecision(
          gate.scope,
          String(req.params.workflowId),
          req.body,
          (tx, id) => candidateAllowed(tx, gate, id),
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/evidence",
  validate({ body: evidenceBody }),
  async (req, res) => {
    const gate = await gateJobAccess(req, res, true);
    if (!gate) return;
    try {
      res.json(
        await recordWorkflowEvidence(
          gate.scope,
          String(req.params.workflowId),
          req.body,
          (tx, id) => candidateAllowed(tx, gate, id),
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.get("/jobs/:jobId/candidate-workflows/:workflowId/follow-ups", async (req, res) => {
  const gate = await gateJobAccess(req, res);
  if (!gate) return;
  try {
    const { readWorkflowFollowUps } = await import("../lib/workflow-follow-ups");
    res.json(await readWorkflowFollowUps(gate.scope, String(req.params.workflowId)));
  } catch (error) {
    handleError(res, error);
  }
});
router.post(
  "/jobs/:jobId/candidate-workflows/:workflowId/follow-ups",
  validate({ body: followUpBody }),
  async (req, res) => {
    const gate = await gateJobAccess(req, res, true, ["approve", "send"].includes(req.body.action));
    if (!gate) return;
    try {
      const { controlWorkflowFollowUp } = await import("../lib/workflow-follow-ups");
      res.json(await controlWorkflowFollowUp(gate.scope, String(req.params.workflowId), req.body));
    } catch (error) {
      handleError(res, error);
    }
  },
);

export default router;
