/** Expiring, audited recipient exception. Never grants execution or verifies identity. */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dbAdmin,
  usersTable,
  candidatesTable,
  recruitingWorkflowsTable as workflows,
  recruitingJourneysTable as journeys,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import type { WorkflowLivePilotInput } from "@workspace/api-zod";
import { atomic, readBrief, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { canControlWorkflowPilot, isIsolatedPilotJob } from "./workflow-pilot-policy";
import { getAllowedTenantIds, getDataScopeTenantIds } from "./tenantUtils";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Pick<typeof dbAdmin, "select">;
type Workflow = typeof workflows.$inferSelect;
const ACTION = "workflow.test_recipient";
const normalize = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
const fail = (message: string, status = 409): never => {
  throw new WorkflowConflict(message, status);
};
const grantSchema = z.object({
  revision: z.number().int().positive(),
  active: z.boolean(),
  candidateId: z.string(),
  journeyId: z.string(),
  journeyVersion: z.number().int(),
  briefHash: z.string(),
  email: z.string().email(),
  recipientUserId: z.string(),
  expiresAt: z.string().datetime(),
});

async function latestGrant(handle: Handle, wf: Workflow) {
  const rows = await handle
    .select()
    .from(events)
    .where(
      and(
        eq(events.workflowId, wf.id),
        eq(events.jobId, wf.jobId),
        eq(events.tenantId, wf.tenantId),
        eq(events.action, ACTION),
      ),
    );
  let latest: { value: z.infer<typeof grantSchema>; actorId: string } | null = null;
  for (const row of rows) {
    try {
      const value = grantSchema.parse(JSON.parse(row.note ?? ""));
      if (!latest || value.revision > latest.value.revision)
        latest = { value, actorId: row.actorId };
      else if (value.revision === latest.value.revision) return null;
    } catch {
      return null;
    } // Corruption must not resurrect an earlier permission.
  }
  return latest;
}

export async function readWorkflowTestRecipient(handle: Handle, wf: Workflow) {
  const stored = await latestGrant(handle, wf);
  const value = stored?.value;
  const status = {
    active: false,
    expiresAt: value ? new Date(value.expiresAt) : null,
    controlledEmail: value?.email ?? null,
  };
  if (
    !stored ||
    !value?.active ||
    wf.status !== "ready" ||
    Date.parse(value.expiresAt) <= Date.now() ||
    value.candidateId !== wf.candidateId ||
    value.journeyId !== wf.journeyId ||
    value.journeyVersion !== wf.journeyVersion
  )
    return status;
  const [actor] = await handle.select().from(usersTable).where(eq(usersTable.id, stored.actorId));
  if (!actor || actor.status !== "active" || !canControlWorkflowPilot(actor.role)) return status;
  const allowed = await getAllowedTenantIds(actor);
  const data = await getDataScopeTenantIds(actor);
  if (
    (allowed !== null && !allowed.includes(wf.tenantId)) ||
    (data !== null && !data.includes(wf.tenantId))
  )
    return status;
  const { job, hash } = await readBrief(handle, {
    jobId: wf.jobId,
    tenantId: wf.tenantId,
    actorId: actor.id,
    canApprove: true,
  });
  if (
    !isIsolatedPilotJob(job.title) ||
    job.status !== "active" ||
    job.recruitingMode !== "lexy_autonomous" ||
    hash !== value.briefHash
  )
    return status;
  const [journey] = await handle
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, wf.journeyId),
        eq(journeys.jobId, wf.jobId),
        eq(journeys.tenantId, wf.tenantId),
      ),
    );
  if (
    !journey ||
    journey.status !== "approved" ||
    journey.version !== wf.journeyVersion ||
    journey.briefHash !== hash
  )
    return status;
  const [candidate] = await handle
    .select()
    .from(candidatesTable)
    .where(and(eq(candidatesTable.id, wf.candidateId), eq(candidatesTable.tenantId, wf.tenantId)));
  if (
    !candidate ||
    candidate.pool !== "tenant" ||
    candidate.dataErasedAt ||
    candidate.doNotContact ||
    candidate.verificationStatus === "verified" ||
    normalize(candidate.email) !== value.email
  )
    return status;
  const [recipient] = await handle
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, value.recipientUserId));
  if (
    !recipient ||
    recipient.status !== "active" ||
    recipient.role !== "candidate" ||
    normalize(recipient.email) !== value.email
  )
    return status;
  return { ...status, active: true };
}

export async function isApprovedWorkflowTestRecipient(handle: Handle, wf: Workflow, email: string) {
  const state = await readWorkflowTestRecipient(handle, wf);
  return state.active && state.controlledEmail === normalize(email);
}

export async function controlWorkflowTestRecipient(
  scope: WorkflowScope,
  workflowId: string,
  input: WorkflowLivePilotInput,
  candidateAllowed: (tx: Tx, id: string) => Promise<boolean>,
) {
  if (!scope.canApprove) fail("A human pilot approver is required.", 403);
  return atomic(scope, ACTION, { ...input, workflowId }, async (tx) => {
    const [actor] = await tx.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
    if (!actor || actor.status !== "active" || !canControlWorkflowPilot(actor.role))
      fail("An active pilot approver is required.", 403);
    const allowed = await getAllowedTenantIds(actor);
    const data = await getDataScopeTenantIds(actor);
    if (
      (allowed !== null && !allowed.includes(scope.tenantId)) ||
      (data !== null && !data.includes(scope.tenantId))
    )
      fail("Not found", 404);
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
      fail("Workflow changed. Refresh before controlling the recipient.");
    const { job, hash } = await readBrief(tx, scope);
    const previous = await latestGrant(tx, wf);
    let value = previous?.value;
    if (input.action === "approve_recipient") {
      if (input.acknowledgeTestRecipient !== true)
        fail("Attest that the profile is fictional and you control this internal test inbox.", 400);
      if (
        !isIsolatedPilotJob(job.title) ||
        job.status !== "active" ||
        job.recruitingMode !== "lexy_autonomous" ||
        wf.status !== "ready"
      )
        fail("Use an approved, ready, isolated autonomous pilot.");
      const [journey] = await tx
        .select()
        .from(journeys)
        .where(
          and(
            eq(journeys.id, wf.journeyId),
            eq(journeys.jobId, wf.jobId),
            eq(journeys.tenantId, wf.tenantId),
          ),
        );
      if (
        !journey ||
        journey.status !== "approved" ||
        journey.version !== wf.journeyVersion ||
        journey.briefHash !== hash
      )
        fail("The approved journey must match the current brief.");
      const [candidate] = await tx
        .select()
        .from(candidatesTable)
        .where(
          and(eq(candidatesTable.id, wf.candidateId), eq(candidatesTable.tenantId, scope.tenantId)),
        )
        .for("update");
      const email = normalize(input.controlledEmail);
      if (
        !candidate ||
        candidate.pool !== "tenant" ||
        candidate.dataErasedAt ||
        candidate.doNotContact ||
        candidate.verificationStatus === "verified" ||
        !email ||
        normalize(candidate.email) !== email
      )
        fail("Use this fixture's current controlled inbox.");
      const [recipient] = await tx
        .select()
        .from(usersTable)
        .where(
          and(
            sql`lower(trim(${usersTable.email})) = ${email}`,
            eq(usersTable.status, "active"),
            eq(usersTable.role, "candidate"),
          ),
        );
      if (!recipient) fail("The test inbox must match an active candidate-portal account.");
      value = {
        revision: wf.revision + 1,
        active: true,
        candidateId: wf.candidateId,
        journeyId: wf.journeyId,
        journeyVersion: wf.journeyVersion,
        briefHash: hash,
        email,
        recipientUserId: recipient.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      // Permanent reporting exclusion, not verified identity or spending authority.
      await tx
        .update(candidatesTable)
        .set({
          verificationResult: sql`coalesce(${candidatesTable.verificationResult}, '{}'::jsonb)
          || jsonb_build_object('syntheticFixture', jsonb_build_object('kind', 'controlled_inbox', 'workflowId', ${wf.id}::text))`,
        })
        .where(
          and(eq(candidatesTable.id, candidate.id), eq(candidatesTable.tenantId, scope.tenantId)),
        );
    } else if (input.action === "revoke_recipient" && value) {
      value = { ...value, active: false, revision: wf.revision + 1 };
    } else fail("There is no recipient permission to revoke.");
    await tx
      .update(workflows)
      .set({ revision: wf.revision + 1, updatedAt: new Date() })
      .where(eq(workflows.id, wf.id));
    return { id: wf.id, workflowId: wf.id, journeyId: wf.journeyId, note: JSON.stringify(value) };
  });
}
