import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  employerAtsBindingsTable as bindings,
  recruitingWorkflowsTable as workflows,
} from "@workspace/db";
import type { AtsStageOwnershipInput, AtsStageOwnershipState } from "@workspace/api-zod";
import { atomic, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { scopedRow, offerAuthority } from "./offer-routing";
import { authorizedAtsPreview } from "./ats-verification";
import { lock } from "./ats-imports";
import { externalStageOwner, lockAtsStageOwner } from "./ats-stage-owner";

type Handle = Parameters<typeof authorizedAtsPreview>[0];
type Visible = Parameters<typeof authorizedAtsPreview>[3];

export async function readAtsStageOwnership(
  h: Handle,
  scope: WorkflowScope,
  workflowId: string,
  visible: Visible,
): Promise<AtsStageOwnershipState> {
  const row = await scopedRow(h, scope, workflowId, visible);
  // Reads need only the current actor's configuration authority, not an
  // employer-wide roster/assignment scan for every polled workflow card.
  const [actor] = await h
    .select({ status: usersTable.status, role: usersTable.role, tenantId: usersTable.tenantId })
    .from(usersTable)
    .where(eq(usersTable.id, scope.actorId));
  const authority = {
    canConfigure:
      actor?.status === "active" &&
      actor.role === "tenant_admin" &&
      actor.tenantId === scope.tenantId,
  };
  const own = row.steps.find((s) => s.key === "hiring_decision")?.atsStageOwnership;
  const active = await externalStageOwner(h, row.candidateId, scope.jobId);
  const declared = active?.steps.find((s) => s.key === "hiring_decision")?.atsStageOwnership;
  const [binding] = await h
    .select({ revision: bindings.revision })
    .from(bindings)
    .where(eq(bindings.tenantId, scope.tenantId));
  let canClaim = false;
  if (authority.canConfigure && scope.canEdit !== false && !active && binding) {
    try {
      await authorizedAtsPreview(h, scope, workflowId, visible, {
        expectedWorkflowRevision: row.revision,
        expectedBindingRevision: binding.revision,
      });
      canClaim = true;
    } catch (error) {
      if (!(error instanceof WorkflowConflict)) throw error;
    }
  }
  return {
    status: active ? "external" : "native",
    ownershipRevision: own?.revision ?? 0,
    workflowRevision: row.revision,
    bindingRevision: binding?.revision ?? null,
    ownerWorkflowId: active?.id ?? null,
    declaredAt: declared?.declaredAt ?? null,
    canClaim,
    canRelease: Boolean(
      authority.canConfigure && scope.canEdit !== false && active?.id === workflowId,
    ),
  };
}

export async function controlAtsStageOwnership(
  scope: WorkflowScope,
  workflowId: string,
  input: AtsStageOwnershipInput,
  visible: Visible,
) {
  const initial = await scopedRow(dbAdmin, scope, workflowId, visible);
  if (!(await offerAuthority(dbAdmin, scope, initial)).canConfigure)
    throw new WorkflowConflict(
      "Only this employer's administrator can assign hiring-stage authority.",
      403,
    );
  if (input.acknowledge !== true || input.reason.trim().length < 10)
    throw new WorkflowConflict(
      "Explicit acknowledgement and a meaningful reason are required.",
      400,
    );
  await atomic(
    scope,
    "ats.stage_ownership",
    input,
    async (tx) => {
      await lock(tx, scope, workflowId);
      const row = await scopedRow(tx, scope, workflowId, visible);
      const authority = await offerAuthority(tx, scope, row);
      if (!authority.canConfigure || scope.canEdit === false)
        throw new WorkflowConflict("Employer administrator required.", 403);
      if (
        row.candidateId !== initial.candidateId ||
        row.revision !== input.expectedWorkflowRevision
      )
        throw new WorkflowConflict("Workflow changed. Reload and review before acting.");
      const step = row.steps.find((s) => s.key === "hiring_decision");
      if (!step) throw new WorkflowConflict("Hiring decision step not found.");
      const old = step.atsStageOwnership;
      if ((old?.revision ?? 0) !== input.expectedOwnershipRevision)
        throw new WorkflowConflict("Stage ownership changed. Reload and review.");
      const active = await externalStageOwner(tx, row.candidateId, scope.jobId);
      let mapping = old?.mapping;
      let bindingRevision = old?.bindingRevision;
      if (input.action === "claim") {
        if (active)
          throw new WorkflowConflict(
            "External ownership is already declared. Release it in its owning workflow first.",
          );
        const allocation = await authorizedAtsPreview(tx, scope, workflowId, visible, input);
        mapping = allocation.mapping;
        bindingRevision = allocation.binding.revision;
      } else if (!old || active?.id !== workflowId) {
        throw new WorkflowConflict("This workflow does not own the external stage declaration.");
      }
      if (!mapping || bindingRevision == null)
        throw new WorkflowConflict("Mapped ATS authority is required.");
      step.atsStageOwnership = {
        status: input.action === "claim" ? "external" : "released",
        revision: (old?.revision ?? 0) + 1,
        mapping,
        bindingRevision,
        declaredBy: scope.actorId,
        declaredAt: new Date().toISOString(),
        reason: input.reason.trim(),
      };
      if (old) step.atsStageOwnershipHistory = [...(step.atsStageOwnershipHistory ?? []), old];
      await tx
        .update(workflows)
        .set({ steps: row.steps, revision: row.revision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.tenantId, scope.tenantId),
            eq(workflows.jobId, scope.jobId),
          ),
        );
      return {
        id: workflowId,
        workflowId,
        note: `Hiring-stage authority ${input.action === "claim" ? "assigned to external ATS" : "explicitly returned to Lexy"}; no stage or offer changed. Reason: ${input.reason.trim()}`,
      };
    },
    (tx) => lockAtsStageOwner(tx, initial.candidateId, scope.jobId),
  );
  return readAtsStageOwnership(dbAdmin, scope, workflowId, visible);
}
