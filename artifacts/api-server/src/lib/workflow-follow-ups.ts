/**
 * Separate, immutable-per-approval contact authority. Journal + receipts use
 * the existing job advisory lock. A claim is permanent even if delivery or
 * its outcome write is lost; neither original outreach nor invitation claims
 * are released. No model generation, invitation links or token rotation.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dbAdmin,
  usersTable,
  candidatesTable,
  recruitingWorkflowsTable as workflows,
  recruitingJourneysTable as journeys,
  recruitingWorkflowEventsTable as events,
  outreachMessagesTable as messages,
  sourcedCandidatesTable as sources,
  outreachEnrollmentsTable as enrollments,
  outreachStepMessagesTable as stepMessages,
  outreachCampaignsTable as campaigns,
  tenantAiBrandProfilesTable,
} from "@workspace/db";
import type { WorkflowFollowUpInput } from "@workspace/api-zod";
import {
  atomic,
  readBrief,
  approvedJob,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import {
  getAllowedTenantIds,
  getDataScopeTenantIds,
  recruiterIsAssignedToJob,
} from "./tenantUtils";
import { assertWorkflowContactPrerequisites } from "./workflow-contact-gates";
import { isIsolatedPilotJob } from "./workflow-pilot-policy";
import { isApprovedWorkflowTestRecipient } from "./workflow-test-recipient";
import { vendorUsageScope } from "./vendor-usage";
import { sendEmail, plainToHtml, type SendEmailResult } from "./email";
import { logger } from "./logger";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Pick<typeof dbAdmin, "select">;
const ACTION = "workflow.followup.updated";
const APPROVERS = ["platform_admin", "tenant_admin", "recruiter_admin", "hiring_manager"];
const schema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  recipient: z.string().email(),
  subject: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
  scheduledAt: z.string().datetime(),
  status: z.enum(["draft", "approved", "claimed", "sent", "unknown", "cancelled"]),
  workflowRevision: z.number().int(),
  journeyId: z.string(),
  journeyVersion: z.number().int(),
  approverId: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
});
type FollowUp = z.infer<typeof schema>;
type Input = Omit<WorkflowFollowUpInput, "scheduledAt"> & { scheduledAt?: string };
const fail = (message: string, status = 409): never => {
  throw new WorkflowConflict(message, status);
};
const where = (scope: WorkflowScope, workflowId: string) =>
  and(
    eq(events.tenantId, scope.tenantId),
    eq(events.jobId, scope.jobId),
    eq(events.workflowId, workflowId),
  );

async function records(handle: Handle, scope: WorkflowScope, workflowId: string) {
  const rows = await handle
    .select()
    .from(events)
    .where(and(where(scope, workflowId), eq(events.action, ACTION)));
  const latest = new Map<string, FollowUp>();
  const seen = new Set<string>();
  for (const row of rows) {
    let value: FollowUp;
    try {
      value = schema.parse(JSON.parse(row.note ?? ""));
    } catch {
      return fail("Follow-up history needs human reconciliation.");
    }
    const key = `${value.id}:${value.version}`;
    if (seen.has(key)) fail("Duplicate follow-up history needs human reconciliation.");
    seen.add(key);
    if (!latest.has(value.id) || latest.get(value.id)!.version < value.version)
      latest.set(value.id, value);
  }
  return [...latest.values()];
}

async function visible(handle: Handle, scope: WorkflowScope, workflowId: string) {
  const [wf] = await handle
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.jobId, scope.jobId),
        eq(workflows.tenantId, scope.tenantId),
      ),
    );
  if (!wf) return fail("Not found", 404);
  const [actor] = await handle.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
  if (!actor || actor.status !== "active") return fail("Unauthorized", 401);
  if (
    ![
      "platform_admin",
      "tenant_admin",
      "recruiter_admin",
      "recruiter",
      "hiring_manager",
      "interviewer",
    ].includes(actor.role)
  )
    return fail("Staff authority required", 403);
  const { job, hash } = await readBrief(handle, scope);
  const allowed = await getDataScopeTenantIds(actor);
  if (
    (allowed !== null && !allowed.includes(job.tenantId)) ||
    (actor.role === "recruiter" && !(await recruiterIsAssignedToJob(actor.id, job))) ||
    (actor.role === "hiring_manager" && job.assignedHiringManagerId !== actor.id)
  )
    return fail("Not found", 404);
  const candidateTenants = await getAllowedTenantIds(actor);
  const rows = await handle
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, wf.candidateId),
        candidateTenants === null
          ? undefined
          : or(
              inArray(candidatesTable.tenantId, candidateTenants),
              eq(candidatesTable.pool, "platform"),
            ),
        sql`EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=${candidatesTable.id} AND a.job_id=${scope.jobId})`,
      ),
    );
  const { applyCandidateHardExclusions, applyCandidatePrivacyFilter } =
    await import("../routes/candidates");
  const filtered = await applyCandidatePrivacyFilter(
    applyCandidateHardExclusions(rows),
    actor.role === "platform_admin" ? null : wf.tenantId,
  );
  const candidate = filtered.find((c) => c.id === wf.candidateId);
  if (!candidate?.email) return fail("Not found", 404);
  return { wf, actor, job, hash, candidate };
}

async function ready(handle: Handle, scope: WorkflowScope, workflowId: string, approval = false) {
  const context = await visible(handle, scope, workflowId);
  const { wf, actor, job, hash, candidate } = context;
  if (approval && (!scope.canApprove || !APPROVERS.includes(actor.role)))
    fail("Human approver authority required", 403);
  if (wf.status !== "ready") fail(`Workflow is ${wf.status}; contact is held.`);
  if (!approvedJob(job.status) || job.recruitingMode !== "lexy_autonomous")
    fail("An approved autonomous requisition is required.");
  // Unknown-cost authority is deliberately an isolated, single-message pilot,
  // not a global paid-execution unlock or a change to assisted functionality.
  if (!isIsolatedPilotJob(job.title))
    fail("Follow-up live execution is currently isolated-pilot only.");
  const [journey] = await handle
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, wf.journeyId),
        eq(journeys.tenantId, scope.tenantId),
        eq(journeys.jobId, scope.jobId),
      ),
    );
  if (
    !journey ||
    journey.status !== "approved" ||
    journey.version !== wf.journeyVersion ||
    journey.briefHash !== hash
  )
    fail("The approved journey is stale.");
  if (
    ["screening", "verification", "engagement"].some((key) => {
      const step = wf.steps.find((s) => s.key === key);
      return (
        !step ||
        step.status !== "completed" ||
        step.authority !== "human_review" ||
        !step.evidence?.trim()
      );
    })
  )
    fail("Review the original screening, identity and engagement before approving a follow-up.");
  await assertWorkflowContactPrerequisites(handle, wf, "engagement");
  const email = candidate.email!.trim().toLowerCase();
  if (!(await isApprovedWorkflowTestRecipient(handle, wf, email))) {
    const owners = await handle
      .select()
      .from(usersTable)
      .where(and(sql`lower(${usersTable.email})=${email}`, eq(usersTable.status, "active")));
    let permitted = false;
    for (const owner of owners) {
      if (
        ![
          "platform_admin",
          "tenant_admin",
          "recruiter_admin",
          "recruiter",
          "hiring_manager",
          "interviewer",
        ].includes(owner.role)
      )
        continue;
      const tenants = await getAllowedTenantIds(owner);
      if (tenants === null || tenants.includes(scope.tenantId)) permitted = true;
    }
    if (!permitted) fail("Approve this controlled test recipient separately before contact.");
  }
  const history = await handle.select().from(events).where(where(scope, workflowId));
  for (const claim of history.filter((e) => e.action === "workflow.execution_claimed")) {
    const attempt = claim.note?.match(/action ([\w-]+) claimed/)?.[1];
    if (!attempt) fail("Original action history needs reconciliation.");
    const confirmed =
      history.some(
        (e) =>
          e.action === "workflow.execution_succeeded" &&
          e.note?.includes(`action ${attempt} succeeded`),
      ) ||
      history.some(
        (e) =>
          e.action === "workflow.execution_no_effect" &&
          (() => {
            try {
              return JSON.parse(e.note ?? "").attemptId === attempt;
            } catch {
              return false;
            }
          })(),
      );
    if (!confirmed)
      fail("An original action has an unresolved outcome. Follow-ups cannot bypass it.");
  }
  if (
    (await records(handle, scope, workflowId)).some((r) =>
      ["claimed", "unknown"].includes(r.status),
    )
  )
    fail("A follow-up has an unresolved outcome. Do not resend.");
  const [negative] = await handle
    .select({ id: messages.id })
    .from(messages)
    .leftJoin(sources, eq(sources.id, messages.candidateId))
    .where(
      and(
        eq(messages.tenantId, scope.tenantId),
        eq(messages.jobId, scope.jobId),
        or(
          eq(messages.candidateId, wf.candidateId),
          and(
            eq(sources.tenantId, scope.tenantId),
            eq(sources.normalizedCandidateId, wf.candidateId),
          ),
        ),
        eq(messages.replySentiment, "negative"),
      ),
    )
    .limit(1);
  if (negative) fail("Candidate declined contact; follow-up is held.");
  const [brand] = await handle
    .select()
    .from(tenantAiBrandProfilesTable)
    .where(eq(tenantAiBrandProfilesTable.tenantId, scope.tenantId));
  if (brand?.aiMessagingEnabled === false) fail("Tenant messaging is disabled.");
  return context;
}

async function save(tx: Tx, scope: WorkflowScope, workflowId: string, value: FollowUp) {
  await tx.insert(events).values({
    tenantId: scope.tenantId,
    jobId: scope.jobId,
    workflowId,
    journeyId: value.journeyId,
    actorId: scope.actorId,
    action: ACTION,
    note: JSON.stringify(value),
  });
}

export async function readWorkflowFollowUps(scope: WorkflowScope, workflowId: string) {
  const { wf, candidate } = await visible(dbAdmin, scope, workflowId);
  let blockedReason: string | null = null;
  try {
    await ready(dbAdmin, scope, workflowId);
  } catch (error) {
    if (!(error instanceof WorkflowConflict)) throw error;
    blockedReason = error.message;
  }
  const list = await records(dbAdmin, scope, workflowId);
  const heldRows = await dbAdmin
    .select({
      id: stepMessages.id,
      subject: stepMessages.subject,
      body: stepMessages.body,
      reason: stepMessages.failedReason,
    })
    .from(stepMessages)
    .innerJoin(enrollments, eq(enrollments.id, stepMessages.enrollmentId))
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .leftJoin(sources, eq(sources.id, enrollments.candidateId))
    .where(
      and(
        eq(enrollments.tenantId, scope.tenantId),
        eq(campaigns.tenantId, scope.tenantId),
        or(eq(enrollments.jobId, scope.jobId), eq(campaigns.jobId, scope.jobId)),
        eq(stepMessages.status, "draft"),
        sql`${stepMessages.failedReason} LIKE 'Held: candidate contact belongs%'`,
        or(
          eq(enrollments.candidateId, wf.candidateId),
          and(
            eq(sources.tenantId, scope.tenantId),
            eq(sources.normalizedCandidateId, wf.candidateId),
          ),
        ),
      ),
    );
  return {
    recipient: candidate.email!.trim().toLowerCase(),
    blockedReason,
    held: heldRows.map((r) => ({ ...r, reason: r.reason! })),
    followUps: list.map((r) => ({
      ...r,
      blockedReason:
        blockedReason ??
        (r.status === "approved" && r.workflowRevision !== wf.revision
          ? "Workflow revision changed; approve this message again."
          : null),
    })),
  };
}

export async function controlWorkflowFollowUp(
  scope: WorkflowScope,
  workflowId: string,
  input: Input,
) {
  if (
    input.action !== "draft" &&
    (input.subject !== undefined || input.body !== undefined || input.scheduledAt !== undefined)
  )
    fail("Save changes as a new draft version before approving or sending.", 400);
  if (input.action === "send") return dispatchWorkflowFollowUp(scope, workflowId, input);
  return atomic(scope, "workflow.followup.control", { ...input, workflowId }, async (tx) => {
    const context =
      input.action === "cancel"
        ? await visible(tx, scope, workflowId)
        : await ready(tx, scope, workflowId, input.action === "approve");
    const { wf, candidate } = context;
    if (wf.revision !== input.expectedRevision) fail("Workflow changed. Refresh first.");
    const old = (await records(tx, scope, workflowId)).find((r) => r.id === input.id);
    if (input.id && !old) fail("Not found", 404);
    if (
      old &&
      (old.version !== input.expectedVersion ||
        ["claimed", "sent", "unknown", "cancelled"].includes(old.status))
    )
      fail("Follow-up changed or is terminal; it cannot be edited or resent.");
    let value: FollowUp;
    if (input.action === "draft") {
      if (!input.subject?.trim() || !input.body?.trim() || !input.scheduledAt)
        return fail("Subject, message and schedule are required.", 400);
      if (/https?:\/\/|\/interviews\/|verification code/i.test(input.body))
        fail("This check-in path cannot issue invitation links or verification codes.", 400);
      const time = Date.parse(input.scheduledAt);
      if (!Number.isFinite(time) || time < Date.now() - 60_000 || time > Date.now() + 7 * 86400_000)
        fail("Schedule within the next seven days.", 400);
      value = schema.parse({
        id: old?.id ?? randomUUID(),
        version: (old?.version ?? 0) + 1,
        recipient: candidate.email!.trim().toLowerCase(),
        subject: input.subject.trim(),
        body: input.body.trim(),
        scheduledAt: new Date(time).toISOString(),
        status: "draft",
        workflowRevision: wf.revision,
        journeyId: wf.journeyId,
        journeyVersion: wf.journeyVersion,
        approverId: null,
        expiresAt: null,
      });
    } else {
      if (!old) return fail("Choose an existing follow-up.", 400);
      if (
        input.action === "approve" &&
        (input.acknowledgeUnknownCost !== true ||
          old.recipient !== candidate.email!.trim().toLowerCase())
      )
        fail("Confirm the exact recipient and acknowledge unknown provider charges.");
      if (input.action === "approve" && Date.parse(old.scheduledAt) + 86400_000 <= Date.now())
        fail("Schedule expired; edit the draft first.");
      value = {
        ...old,
        version: old.version + 1,
        status: input.action === "cancel" ? "cancelled" : "approved",
        workflowRevision: wf.revision,
        approverId: input.action === "approve" ? scope.actorId : null,
        expiresAt:
          input.action === "approve"
            ? new Date(Date.parse(old.scheduledAt) + 86400_000).toISOString()
            : null,
      };
    }
    await save(tx, scope, workflowId, value);
    return {
      id: value.id,
      workflowId,
      journeyId: wf.journeyId,
      note: `Follow-up ${value.id} ${value.status}; no original claim changed.`,
    };
  });
}

export async function dispatchWorkflowFollowUp(
  scope: WorkflowScope,
  workflowId: string,
  input: Input,
  testTransport?: (value: FollowUp) => Promise<SendEmailResult>,
) {
  if (testTransport && process.env.NODE_ENV !== "test") fail("Test transport is test-only.", 403);
  if (!input.id) return fail("Choose a follow-up.", 400);
  let claimed: FollowUp | undefined;
  const result = await atomic(
    scope,
    "workflow.followup.claimed",
    {
      workflowId,
      id: input.id,
      idempotencyKey: `followup:send:${workflowId}:${input.id}`,
    },
    async (tx) => {
      const { wf, candidate } = await ready(tx, scope, workflowId, true);
      if (wf.revision !== input.expectedRevision) fail("Workflow changed. Refresh first.");
      const value = (await records(tx, scope, workflowId)).find((r) => r.id === input.id);
      if (!value) return fail("Not found", 404);
      if (value.version !== input.expectedVersion || value.status !== "approved")
        fail("Only the current approved message may be sent.");
      if (
        value.workflowRevision !== wf.revision ||
        value.journeyId !== wf.journeyId ||
        value.journeyVersion !== wf.journeyVersion ||
        value.recipient !== candidate.email!.trim().toLowerCase()
      )
        fail("Approval no longer matches this workflow and recipient.");
      if (Date.parse(value.scheduledAt) > Date.now()) fail("This follow-up is not due yet.");
      if (!value.expiresAt || Date.parse(value.expiresAt) <= Date.now())
        fail("Follow-up approval expired.");
      const [approver] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, value.approverId ?? ""));
      if (!approver || approver.status !== "active" || !APPROVERS.includes(approver.role))
        fail("Original approver no longer has authority.");
      // Recheck the original approver's present ownership, not just the worker/caller.
      await ready(tx, { ...scope, actorId: approver.id, canApprove: true }, workflowId, true);
      claimed = { ...value, version: value.version + 1, status: "claimed" };
      await save(tx, scope, workflowId, claimed);
      return {
        id: value.id,
        workflowId,
        journeyId: wf.journeyId,
        note: `Follow-up ${value.id} claimed permanently; no automatic retry.`,
      };
    },
  );
  if (result.replayed || !claimed) return result;
  const value = claimed;
  let state: "sent" | "unknown" = "unknown";
  try {
    const output = await vendorUsageScope.run(
      { tenantId: scope.tenantId, area: `workflow:${workflowId}:engagement` },
      async () => {
        const transport = testTransport
          ? testTransport(value)
          : sendEmail({
              to: value.recipient,
              subject: value.subject,
              text: value.body,
              html: plainToHtml(value.body),
              audit: { tenantId: scope.tenantId, actorLabel: "approved-workflow-follow-up" },
            });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            transport,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Follow-up deadline exceeded")), 30_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    );
    if (output.ok && !output.simulated && !output.suppressed) state = "sent";
  } catch {
    /* Claimed remains permanently blocked even if outcome persistence fails. */
  }
  await dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recruiting-workflow:${scope.jobId}`},0))`,
    );
    await save(tx, scope, workflowId, { ...value, version: value.version + 1, status: state });
  });
  return result;
}

/** Piggybacks the existing scheduler; no new process or detached retries. */
export async function dispatchDueWorkflowFollowUps(
  testTransport?: (value: FollowUp) => Promise<SendEmailResult>,
) {
  if (testTransport && process.env.NODE_ENV !== "test") fail("Test transport is test-only.", 403);
  // Select current due approvals, not the first page of historical approvals:
  // sent/cancelled snapshots must not eventually starve the pending queue.
  const approvals = await dbAdmin
    .select()
    .from(events)
    .where(
      and(
        eq(events.action, ACTION),
        sql`${events.note}::jsonb->>'status' = 'approved'`,
        sql`(${events.note}::jsonb->>'scheduledAt')::timestamptz <= CURRENT_TIMESTAMP`,
        sql`(${events.note}::jsonb->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP`,
        sql`NOT EXISTS (SELECT 1 FROM recruiting_workflow_events newer
      WHERE newer.action=${ACTION} AND newer.tenant_id=${events.tenantId}
      AND newer.job_id=${events.jobId} AND newer.workflow_id=${events.workflowId}
      AND newer.note::jsonb->>'id'=${events.note}::jsonb->>'id'
      AND (newer.note::jsonb->>'version')::int > (${events.note}::jsonb->>'version')::int)`,
      ),
    )
    .limit(1000);
  const visited = new Set<string>();
  for (const approval of approvals) {
    if (!approval.workflowId || visited.has(approval.workflowId)) continue;
    visited.add(approval.workflowId);
    try {
      const baseScope = {
        jobId: approval.jobId,
        tenantId: approval.tenantId,
        actorId: approval.actorId,
        canApprove: true,
      };
      for (const value of await records(dbAdmin, baseScope, approval.workflowId)) {
        if (
          value.status !== "approved" ||
          !value.approverId ||
          Date.parse(value.scheduledAt) > Date.now()
        )
          continue;
        const scope = { ...baseScope, actorId: value.approverId };
        const { wf } = await visible(dbAdmin, scope, approval.workflowId);
        await dispatchWorkflowFollowUp(
          scope,
          wf.id,
          {
            action: "send",
            id: value.id,
            expectedVersion: value.version,
            expectedRevision: wf.revision,
            idempotencyKey: randomUUID(),
          },
          testTransport,
        );
      }
    } catch (error) {
      logger.info(
        { workflowId: approval.workflowId, held: error instanceof WorkflowConflict },
        "[workflow-follow-up] Due contact held; no automatic reconciliation",
      );
    }
  }
}
