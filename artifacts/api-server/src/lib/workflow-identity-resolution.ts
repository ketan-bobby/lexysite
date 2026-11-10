import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dbAdmin,
  jobsTable,
  usersTable,
  candidatesTable,
  verificationRecordsTable as records,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import type { WorkflowIdentityResolutionInput } from "@workspace/api-zod";
import {
  atomic,
  approvedJob,
  readBrief,
  fingerprint,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { canControlWorkflowPilot, isIsolatedPilotJob } from "./workflow-pilot-policy";
import { getAllowedTenantIds, getDataScopeTenantIds } from "./tenantUtils";
import { isApprovedWorkflowTestRecipient } from "./workflow-test-recipient";
import { restrictToRealCandidates } from "./synthetic-fixture-scope";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Pick<typeof dbAdmin, "select">;
type Workflow = typeof workflows.$inferSelect;
const ACTION = "workflow.identity_resolved";
const normalize = (email: string | null) => email?.trim().toLowerCase() ?? "";
const fail = (message: string, status = 409): never => {
  throw new WorkflowConflict(message, status);
};
const clearance = z.object({
  decision: z.literal("internal_test"),
  candidateId: z.string(),
  recordId: z.string(),
  recordUpdatedAt: z.string(),
  recordFingerprint: z.string(),
  journeyId: z.string(),
  journeyVersion: z.number(),
  briefHash: z.string(),
  controlledEmail: z.string().email(),
  evidence: z.string().min(30),
});

async function controlledStaffInbox(handle: Handle, wf: Workflow, email: string) {
  const [job] = await handle
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, wf.jobId), eq(jobsTable.tenantId, wf.tenantId)));
  if (!job || !approvedJob(job.status) || !isIsolatedPilotJob(job.title))
    fail(
      "Synthetic clearance is only available on a separate, approved AUTONOMY PILOT work order.",
    );
  if (await isApprovedWorkflowTestRecipient(handle, wf, email)) return;
  const staff = await handle
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.status, "active"),
        sql`lower(trim(${usersTable.email})) = ${email}`,
        sql`${usersTable.role} IN ('platform_admin','tenant_admin','recruiter_admin','recruiter','hiring_manager','interviewer')`,
      ),
    );
  let covered = false;
  for (const user of staff) {
    const allowed = await getAllowedTenantIds(user);
    const data = await getDataScopeTenantIds(user);
    if (
      (allowed === null || allowed.includes(wf.tenantId)) &&
      (data === null || data.includes(wf.tenantId))
    ) {
      covered = true;
      break;
    }
  }
  if (!email || !covered)
    fail(
      "Synthetic clearance requires an authorised staff inbox or an active workflow-specific test-recipient permission.",
    );
}

/** Test-only clearance cannot escape its workflow, source version or staff inbox. */
export async function hasWorkflowTestIdentityClearance(handle: Handle, wf: Workflow) {
  if (
    wf.status !== "ready" ||
    wf.steps.find((s) => s.key === "verification")?.status !== "completed"
  )
    return false;
  const [entry] = await handle
    .select()
    .from(events)
    .where(
      and(
        eq(events.tenantId, wf.tenantId),
        eq(events.jobId, wf.jobId),
        eq(events.workflowId, wf.id),
        eq(events.journeyId, wf.journeyId),
        eq(events.action, ACTION),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(1);
  let data: z.infer<typeof clearance>;
  try {
    data = clearance.parse(JSON.parse(entry?.note ?? ""));
  } catch {
    return false;
  }
  if (
    data.candidateId !== wf.candidateId ||
    data.journeyId !== wf.journeyId ||
    data.journeyVersion !== wf.journeyVersion
  )
    return false;
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
    journey.briefHash !== data.briefHash
  )
    return false;
  const [candidate] = await handle
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, wf.candidateId));
  if (
    !candidate ||
    candidate.dataErasedAt ||
    candidate.doNotContact ||
    normalize(candidate.email) !== data.controlledEmail
  )
    return false;
  const [record] = await handle
    .select()
    .from(records)
    .where(
      and(
        eq(records.id, data.recordId),
        eq(records.candidateId, candidate.id),
        eq(records.tenantId, candidate.tenantId),
        eq(records.status, "pending"),
        eq(records.identityVerified, false),
      ),
    );
  if (
    !record ||
    record.updatedAt.toISOString() !== data.recordUpdatedAt ||
    fingerprint(record) !== data.recordFingerprint
  )
    return false;
  try {
    await controlledStaffInbox(handle, wf, data.controlledEmail);
  } catch {
    return false;
  }
  return true;
}

export async function resolveWorkflowIdentity(
  scope: WorkflowScope,
  workflowId: string,
  input: WorkflowIdentityResolutionInput,
  candidateAllowed: (tx: Tx, id: string) => Promise<boolean>,
) {
  if (!scope.canApprove) fail("Identity resolution requires a human approver.", 403);
  if (!input.acknowledge || input.evidence.trim().length < 30)
    fail("Describe the evidence and explicitly acknowledge the selected decision.", 400);
  return atomic(scope, ACTION, { ...input, workflowId }, async (tx) => {
    const [actor] = await tx.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
    if (!actor || actor.status !== "active" || !canControlWorkflowPilot(actor.role))
      fail("Identity resolution requires an active human approver.", 403);
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
    if (wf.revision !== input.expectedRevision || wf.status !== "ready")
      fail("Workflow changed, is paused or terminal. Refresh before resolving identity.");
    const current = await readBrief(tx, scope);
    const [journey] = await tx
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
      !approvedJob(current.job.status) ||
      !journey ||
      journey.status !== "approved" ||
      journey.version !== wf.journeyVersion ||
      journey.briefHash !== current.hash
    )
      fail("Identity resolution needs an approved, current journey and work order.");
    if (wf.steps.find((s) => s.status !== "completed")?.key !== "verification")
      fail("Complete screening first; identity resolution cannot skip or reopen workflow steps.");
    const [candidate] = await tx
      .select()
      .from(candidatesTable)
      .where(eq(candidatesTable.id, wf.candidateId))
      .for("update");
    if (!candidate || candidate.dataErasedAt || candidate.doNotContact) fail("Not found", 404);
    // Job visibility (including platform discovery) does not authorise global identity writes.
    const owners = await getAllowedTenantIds(actor);
    if (owners !== null && !owners.includes(candidate.tenantId)) fail("Not found", 404);
    const [record] = await tx
      .select()
      .from(records)
      .where(
        and(
          eq(records.id, input.recordId),
          eq(records.candidateId, candidate.id),
          eq(records.tenantId, candidate.tenantId),
        ),
      )
      .for("update");
    if (!record) fail("Not found", 404);
    if (
      record.updatedAt.toISOString() !== input.recordUpdatedAt.toISOString() ||
      !["pending", "review", "flagged"].includes(record.status) ||
      record.identityVerified
    )
      fail(
        "Identity evidence changed or is already verified. Refresh; existing verification will not be overwritten.",
      );
    const internal = input.decision === "internal_test";
    const verified = input.decision === "corroborated";
    if (verified) {
      const [realCandidate] = await tx
        .select({ id: candidatesTable.id })
        .from(candidatesTable)
        .where(
          and(
            eq(candidatesTable.id, candidate.id),
            eq(candidatesTable.tenantId, candidate.tenantId),
            restrictToRealCandidates(candidatesTable.id),
          ),
        );
      if (!realCandidate)
        fail(
          "A known synthetic fixture cannot receive real-person identity corroboration. Use its separate test-only clearance.",
        );
    }
    const now = new Date();
    const evidence = input.evidence.trim();
    const email = normalize(candidate.email);
    if (internal) {
      if (record.status !== "pending")
        fail("Flagged identity requires resolution, not a synthetic-test bypass.");
      await controlledStaffInbox(tx, wf, email);
      // Durable server-owned classification; does not verify identity or grant
      // contact authority. The audit and marker commit in the same transaction.
      await tx
        .update(candidatesTable)
        .set({
          verificationResult: sql`coalesce(${candidatesTable.verificationResult}, '{}'::jsonb)
          || jsonb_build_object('syntheticFixture',
            jsonb_build_object('kind',
              CASE WHEN ${candidatesTable.verificationResult} #>> '{syntheticFixture,kind}' = 'controlled_inbox'
                THEN 'controlled_inbox' ELSE 'staff_inbox' END,
              'workflowId', ${wf.id}::text))`,
        })
        .where(
          and(
            eq(candidatesTable.id, candidate.id),
            eq(candidatesTable.tenantId, candidate.tenantId),
          ),
        );
    } else {
      await tx
        .update(records)
        .set({
          status: verified ? "verified" : record.status,
          identityVerified: verified,
          reviewedAt: now,
          updatedAt: now,
          reviewNotes:
            `${record.reviewNotes ?? ""}\nHuman ${input.decision} review by ${scope.actorId} at ${now.toISOString()}: ${evidence}`.trim(),
        })
        .where(and(eq(records.id, record.id), eq(records.tenantId, candidate.tenantId)));
      const original =
        candidate.verificationResult && typeof candidate.verificationResult === "object"
          ? candidate.verificationResult
          : {};
      await tx
        .update(candidatesTable)
        .set({
          verificationStatus: verified
            ? "verified"
            : record.status === "flagged"
              ? "flagged"
              : "pending",
          updatedAt: now,
          verificationResult: {
            ...original,
            humanResolution: {
              decision: input.decision,
              reviewerId: scope.actorId,
              reviewedAt: now.toISOString(),
              evidence,
            },
          },
        })
        .where(
          and(
            eq(candidatesTable.id, candidate.id),
            eq(candidatesTable.tenantId, candidate.tenantId),
          ),
        );
    }
    const label = internal
      ? "Synthetic controlled-inbox pilot clearance only — identity remains unverified"
      : verified
        ? "Human-corroborated identity evidence"
        : "Identity unresolved — candidate contact blocked";
    await tx
      .update(workflows)
      .set({
        revision: wf.revision + 1,
        updatedAt: now,
        steps: wf.steps.map((s) =>
          s.key === "verification"
            ? {
                ...s,
                label: internal ? "Identity review — synthetic test only" : s.label,
                status:
                  input.decision === "unresolved"
                    ? ("review_required" as const)
                    : ("completed" as const),
                evidence: `${label}. Reviewed by ${scope.actorId}. Source ${record.id}. ${evidence}`,
              }
            : s,
        ),
      })
      .where(and(eq(workflows.id, wf.id), eq(workflows.tenantId, wf.tenantId)));
    return {
      id: wf.id,
      workflowId: wf.id,
      journeyId: wf.journeyId,
      note: JSON.stringify({
        decision: input.decision,
        candidateId: candidate.id,
        recordId: record.id,
        recordUpdatedAt: internal ? record.updatedAt.toISOString() : now.toISOString(),
        journeyId: wf.journeyId,
        journeyVersion: wf.journeyVersion,
        briefHash: journey.briefHash,
        recordFingerprint: fingerprint(record),
        controlledEmail: internal ? email : null,
        evidence,
      }),
    };
  });
}
