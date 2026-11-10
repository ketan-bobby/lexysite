import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  atsRefreshSchedulesTable as schedules,
  atsRefreshRunsTable as runs,
  atsImportedApplicationsTable as imports,
} from "@workspace/db";
import type { AtsScheduleInput, AtsScheduleState } from "@workspace/api-zod";
import { WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { scopedRow, offerAuthority } from "./offer-routing";
import { authorizedAtsPreview } from "./ats-verification";
import { atsPreviewIdentity } from "./ats-preview";
import { lock } from "./ats-imports";

type Handle = Parameters<typeof authorizedAtsPreview>[0];
export type ScheduleVisible = Parameters<typeof authorizedAtsPreview>[3];

export async function scheduleAdmin(
  h: Handle,
  scope: WorkflowScope,
  workflowId: string,
  visible: ScheduleVisible,
) {
  const [user] = await h.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
  if (
    !user ||
    user.status !== "active" ||
    user.role !== "tenant_admin" ||
    user.tenantId !== scope.tenantId ||
    scope.canEdit === false
  )
    throw new WorkflowConflict(
      "Approval by this employer's active administrator is required.",
      403,
    );
  const row = await scopedRow(h, scope, workflowId, visible);
  const authority = await offerAuthority(h, scope, row);
  if (!authority.canConfigure)
    throw new WorkflowConflict("Employer ownership authority is required.", 403);
  return row;
}

export async function scheduleRows(
  h: Handle,
  scope: WorkflowScope,
  workflowId: string,
): Promise<AtsScheduleState> {
  const [s] = await h
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.tenantId, scope.tenantId),
        eq(schedules.jobId, scope.jobId),
        eq(schedules.workflowId, workflowId),
      ),
    );
  const history = await h
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, scope.tenantId),
        eq(runs.jobId, scope.jobId),
        eq(runs.workflowId, workflowId),
      ),
    )
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(20);
  return {
    schedule: s
      ? {
          revision: s.revision,
          status: s.status,
          recordIds: s.recordIds,
          intervalMinutes: s.intervalMinutes,
          nextRunAt: s.nextRunAt?.toISOString() ?? null,
          updatedAt: s.updatedAt.toISOString(),
          blockedReason: s.blockedReason,
        }
      : null,
    runs: history.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      message: r.message,
      items: r.items,
    })),
  };
}

export async function readAtsSchedule(
  scope: WorkflowScope,
  workflowId: string,
  visible: ScheduleVisible,
) {
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, scope, workflowId);
    await scheduleAdmin(tx, scope, workflowId, visible);
    return scheduleRows(tx, scope, workflowId);
  });
}

export async function controlAtsSchedule(
  scope: WorkflowScope,
  workflowId: string,
  input: AtsScheduleInput,
  visible: ScheduleVisible,
) {
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, scope, workflowId);
    const workflow = await scheduleAdmin(tx, scope, workflowId, visible);
    const [s] = await tx
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.tenantId, scope.tenantId),
          eq(schedules.jobId, scope.jobId),
          eq(schedules.workflowId, workflowId),
        ),
      );
    if ((s?.revision ?? 0) !== input.expectedScheduleRevision)
      throw new WorkflowConflict("Schedule changed. Reload before acting.");
    if (input.action === "pause") {
      if (!s) throw new WorkflowConflict("No schedule exists to pause.");
      // Revoked provider grants never prevent an employer from stopping reads.
      await tx
        .update(schedules)
        .set({
          status: "paused",
          nextRunAt: null,
          blockedReason: "Paused by employer administrator.",
          revision: s.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(schedules.id, s.id), eq(schedules.tenantId, scope.tenantId)));
      return scheduleRows(tx, scope, workflowId);
    }
    const ids = input.recordIds ?? [];
    if (
      input.acknowledgeReadOnly !== true ||
      ![60, 360, 1440].includes(input.intervalMinutes ?? 0) ||
      ids.length < 1 ||
      ids.length > 10 ||
      new Set(ids).size !== ids.length
    )
      throw new WorkflowConflict(
        "Acknowledge scheduled reads and select one to ten distinct imported records.",
        400,
      );
    if (workflow.revision !== input.expectedWorkflowRevision)
      throw new WorkflowConflict("Workflow changed. Reload before approving a schedule.");
    const allocation = await authorizedAtsPreview(tx, scope, workflowId, visible, input);
    const records = await tx
      .select({ id: imports.id })
      .from(imports)
      .where(
        and(
          eq(imports.tenantId, scope.tenantId),
          eq(imports.jobId, scope.jobId),
          eq(imports.accountRef, allocation.binding.accountRef),
          eq(imports.externalJobId, allocation.mapping.externalJobId),
          inArray(imports.id, ids),
        ),
      );
    if (records.length !== ids.length)
      throw new WorkflowConflict("Imported record not found.", 404);
    const [running] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, scope.tenantId),
          eq(runs.workflowId, workflowId),
          eq(runs.status, "running"),
        ),
      );
    if (running)
      throw new WorkflowConflict(
        "A prior run is still finishing. Pause and wait before reapproving.",
      );
    const now = new Date();
    const values = {
      ownerUserId: scope.actorId,
      revision: (s?.revision ?? 0) + 1,
      status: "enabled" as const,
      recordIds: ids,
      intervalMinutes: input.intervalMinutes!,
      bindingRevision: input.expectedBindingRevision,
      workflowRevision: input.expectedWorkflowRevision,
      authorityHash: atsPreviewIdentity(scope, workflowId, workflow.revision, allocation),
      nextRunAt: new Date(now.getTime() + input.intervalMinutes! * 60_000),
      blockedReason: null,
      updatedAt: now,
    };
    if (s)
      await tx
        .update(schedules)
        .set(values)
        .where(and(eq(schedules.id, s.id), eq(schedules.tenantId, scope.tenantId)));
    else
      await tx.insert(schedules).values({
        id: randomUUID(),
        tenantId: scope.tenantId,
        jobId: scope.jobId,
        workflowId,
        ...values,
      });
    return scheduleRows(tx, scope, workflowId);
  });
}
