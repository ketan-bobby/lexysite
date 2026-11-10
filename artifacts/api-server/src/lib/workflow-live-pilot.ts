/**
 * A deliberately separate authority from the USD sourcing meter.
 * One selected pilot step; engagement pairs a held draft with a separately approved first send.
 * No spending guarantee, inherited authority or bulk/live rollout.
 * Approval is audited in the existing workflow journal, not an environment switch.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  candidatesTable,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
} from "@workspace/db";
import { atomic, readBrief, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { getDataScopeTenantIds, getAllowedTenantIds } from "./tenantUtils";
import type { WorkflowLivePilotInput, WorkflowLivePilotStatus } from "@workspace/api-zod";
import { assertWorkflowContactPrerequisites } from "./workflow-contact-gates";
import { workflowActionKey } from "./workflow-action-recovery";
import { isIsolatedPilotJob, WORKFLOW_PILOT_APPROVERS as APPROVERS } from "./workflow-pilot-policy";
import {
  controlWorkflowTestRecipient,
  isApprovedWorkflowTestRecipient,
  readWorkflowTestRecipient,
} from "./workflow-test-recipient";
export { canControlWorkflowPilot, isIsolatedPilotJob } from "./workflow-pilot-policy";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Tx | typeof dbAdmin;
type Workflow = typeof workflows.$inferSelect;
const ACTION = "workflow.live_screening_pilot";
function fail(message: string, status = 409): never {
  throw new WorkflowConflict(message, status);
}
const normalize = (email: string | null | undefined) => email?.trim().toLowerCase() ?? "";
type Grant = {
  stepKey?: "screening" | "verification" | "engagement" | "ai_interview";
  revision: number;
  active: boolean;
  journeyId: string;
  journeyVersion: number;
  candidateId: string;
  email: string;
  expiresAt: string;
};

async function grant(handle: Handle, scope: WorkflowScope, wf: Workflow) {
  const rows = await handle
    .select()
    .from(events)
    .where(
      and(
        eq(events.jobId, scope.jobId),
        eq(events.tenantId, scope.tenantId),
        eq(events.workflowId, wf.id),
        eq(events.action, ACTION),
      ),
    );
  let latest: { value: Grant; actorId: string } | null = null;
  for (const row of rows) {
    let value: Grant;
    try {
      value = JSON.parse(row.note ?? "") as Grant;
      if (
        !Number.isInteger(value.revision) ||
        value.revision < 1 ||
        typeof value.active !== "boolean" ||
        typeof value.email !== "string" ||
        typeof value.candidateId !== "string" ||
        typeof value.journeyId !== "string" ||
        !Number.isInteger(value.journeyVersion) ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        (value.stepKey !== undefined &&
          !["screening", "verification", "engagement", "ai_interview"].includes(value.stepKey))
      ) {
        return null; // Corrupt authority must never restore an older grant.
      }
    } catch {
      return null;
    }
    if (!latest || value.revision > latest.value.revision) latest = { value, actorId: row.actorId };
  }
  return latest;
}

async function controlledRecipient(
  handle: Handle,
  scope: WorkflowScope,
  wf: Workflow,
  email: string,
) {
  const [candidate] = await handle
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, wf.candidateId));
  if (!email || normalize(candidate?.email) !== email)
    fail("Use this candidate's current controlled inbox.");
  if (await isApprovedWorkflowTestRecipient(handle, wf, email)) return;
  const owners = await handle
    .select()
    .from(usersTable)
    .where(and(sql`lower(${usersTable.email})=${email}`, eq(usersTable.status, "active")));
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
    const allowed = await getAllowedTenantIds(owner);
    if (allowed === null || allowed.includes(scope.tenantId)) return;
  }
  fail(
    "Use an active staff inbox with tenant access, or separately approve this candidate-login test recipient.",
  );
}

/** Recovery opens a new claim generation, not fresh spending authority. */
export async function revokeWorkflowPilotForRecovery(tx: Tx, scope: WorkflowScope, wf: Workflow) {
  const stored = await grant(tx, scope, wf);
  if (stored)
    await tx.insert(events).values({
      tenantId: scope.tenantId,
      jobId: scope.jobId,
      workflowId: wf.id,
      journeyId: wf.journeyId,
      actorId: scope.actorId,
      action: ACTION,
      note: JSON.stringify({ ...stored.value, active: false, revision: wf.revision + 1 }),
    });
}

export async function readWorkflowPilot(
  handle: Handle,
  scope: WorkflowScope,
  wf: Workflow,
  title: string,
): Promise<WorkflowLivePilotStatus> {
  const next = wf.steps.find((s) => s.status !== "completed")?.key;
  const stepKey =
    next === "screening" ||
    next === "verification" ||
    next === "engagement" ||
    next === "ai_interview"
      ? next
      : null;
  if (!isIsolatedPilotJob(title))
    return { eligible: false, active: false, attempted: false, expiresAt: null, stepKey: null };
  const stored = await grant(handle, scope, wf);
  const [attempt] = await handle
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.tenantId, scope.tenantId),
        eq(receipts.jobId, scope.jobId),
        eq(receipts.key, await workflowActionKey(handle, scope, wf, stepKey!, "agent")),
      ),
    );
  const value = stored?.value;
  const [sendAttempt] =
    stepKey === "engagement"
      ? await handle
          .select({ id: receipts.id })
          .from(receipts)
          .where(
            and(
              eq(receipts.tenantId, scope.tenantId),
              eq(receipts.jobId, scope.jobId),
              eq(
                receipts.key,
                `workflow-action:${wf.id}:${wf.journeyVersion}:engagement:outreach_send`,
              ),
            ),
          )
      : [];
  let active =
    !!value?.active &&
    value.candidateId === wf.candidateId &&
    value.journeyId === wf.journeyId &&
    value.journeyVersion === wf.journeyVersion &&
    (value.stepKey ?? "screening") === stepKey &&
    Date.parse(value.expiresAt) > Date.now();
  if (active) {
    try {
      await assertWorkflowPilotAllowed(handle, scope, {
        workflowId: wf.id,
        stepKey: stepKey!,
        actionKind: "agent",
      });
    } catch (error) {
      if (!(error instanceof WorkflowConflict)) throw error;
      active = false;
    }
  }
  return {
    eligible: isIsolatedPilotJob(title),
    stepKey,
    active,
    attempted: !!attempt,
    sendAttempted: !!sendAttempt,
    expiresAt: value ? new Date(value.expiresAt) : null,
    testRecipient: await readWorkflowTestRecipient(handle, wf),
  };
}

export async function controlWorkflowPilot(
  scope: WorkflowScope,
  workflowId: string,
  input: WorkflowLivePilotInput,
  candidateAllowed: (tx: Tx, id: string) => Promise<boolean>,
) {
  if (input.action === "approve_recipient" || input.action === "revoke_recipient")
    return controlWorkflowTestRecipient(scope, workflowId, input, candidateAllowed);
  return atomic(scope, ACTION, { ...input, workflowId }, async (tx) => {
    const [actor] = await tx.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
    if (!actor || actor.status !== "active" || !APPROVERS.includes(actor.role))
      fail("Approval authority required", 403);
    const { job, hash } = await readBrief(tx, scope);
    const allowed = await getDataScopeTenantIds(actor);
    if (allowed !== null && !allowed.includes(job.tenantId)) fail("Not found", 404);
    const [wf] = await tx
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.jobId, scope.jobId),
          eq(workflows.tenantId, scope.tenantId),
        ),
      )
      .for("update");
    if (!wf || !(await candidateAllowed(tx, wf.candidateId))) fail("Not found", 404);
    if (wf.revision !== input.expectedRevision)
      fail("Workflow changed. Refresh before controlling the pilot.");
    const email = normalize(input.controlledEmail);
    const stepKey = input.stepKey ?? "screening";
    if (input.action === "activate") {
      if (!isIsolatedPilotJob(job.title))
        fail("Use a separate work order named [AUTONOMY PILOT] followed by its role.");
      if (
        job.status !== "active" ||
        job.recruitingMode !== "lexy_autonomous" ||
        wf.status !== "ready"
      )
        fail("An approved ready autonomous workflow is required.");
      const { recruitingJourneysTable: journeys } = await import("@workspace/db");
      const [journey] = await tx
        .select()
        .from(journeys)
        .where(
          and(
            eq(journeys.id, wf.journeyId),
            eq(journeys.jobId, scope.jobId),
            eq(journeys.tenantId, scope.tenantId),
          ),
        );
      if (
        !journey ||
        journey.status !== "approved" ||
        journey.briefHash !== hash ||
        journey.version !== wf.journeyVersion
      )
        fail("The approved journey must match the current brief.");
      if (input.acknowledgeUnknownCosts !== true)
        fail("Acknowledge unknown provider charges; this pilot has no USD guarantee.", 400);
      const state = await readWorkflowPilot(tx, scope, wf, job.title);
      if (
        (state.attempted && stepKey !== "engagement") ||
        state.sendAttempted ||
        state.stepKey !== stepKey
      )
        fail(
          "Approve only the next supported step after reviewing its prerequisites; claimed effects cannot retry.",
        );
      await controlledRecipient(tx, scope, wf, email);
      await assertWorkflowContactPrerequisites(tx, wf, stepKey);
    }
    const revision = wf.revision + 1;
    const value: Grant = {
      stepKey,
      revision,
      active: input.action === "activate",
      journeyId: wf.journeyId,
      journeyVersion: wf.journeyVersion,
      candidateId: wf.candidateId,
      email,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    await tx
      .update(workflows)
      .set({ revision, updatedAt: new Date() })
      .where(eq(workflows.id, wf.id));
    return { id: wf.id, workflowId: wf.id, journeyId: wf.journeyId, note: JSON.stringify(value) };
  });
}

export async function assertWorkflowPilotAllowed(
  tx: Handle,
  scope: WorkflowScope,
  input: { workflowId: string; stepKey: string; actionKind: string },
) {
  // No sourcing/bulk authority. Engagement permits one draft AND one explicitly approved send.
  if (
    !(
      ["screening", "verification", "engagement", "ai_interview"].includes(input.stepKey) &&
      (input.actionKind === "agent" ||
        (input.stepKey === "engagement" && input.actionKind === "outreach_send"))
    )
  )
    fail("Workflow action locked: this action is not implemented in the controlled pilot.");
  const { job } = await readBrief(tx, scope);
  const [wf] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, input.workflowId),
        eq(workflows.jobId, scope.jobId),
        eq(workflows.tenantId, scope.tenantId),
      ),
    );
  if (!wf || !isIsolatedPilotJob(job.title))
    fail("Workflow action locked: isolated pilot approval required.");
  const stored = await grant(tx, scope, wf);
  if (!stored?.value.active || Date.parse(stored.value.expiresAt) <= Date.now())
    fail("Workflow action locked: current explicit approval required.");
  const value = stored.value;
  if ((value.stepKey ?? "screening") !== input.stepKey)
    fail("This assessment needs its own explicit pilot approval.");
  if (
    value.candidateId !== wf.candidateId ||
    value.journeyId !== wf.journeyId ||
    value.journeyVersion !== wf.journeyVersion
  )
    fail("Pilot authority does not match this workflow.");
  const [approver] = await tx.select().from(usersTable).where(eq(usersTable.id, stored.actorId));
  if (!approver || approver.status !== "active" || !APPROVERS.includes(approver.role))
    fail("Pilot approver no longer has authority.");
  const allowed = await getDataScopeTenantIds(approver);
  if (allowed !== null && !allowed.includes(scope.tenantId))
    fail("Pilot approver no longer has tenant authority.");
  await controlledRecipient(tx, scope, wf, value.email);
  await assertWorkflowContactPrerequisites(tx, wf, input.stepKey);
}
