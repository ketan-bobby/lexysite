import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  dbAdmin,
  atsImportedApplicationsTable as imports,
  atsImportObservationsTable as observations,
} from "@workspace/db";
import type { AtsImportHistory, AtsRefreshInput } from "@workspace/api-zod";
import { WorkflowConflict, fingerprint, type WorkflowScope } from "./recruiting-workflows";
import { authorizedAtsPreview } from "./ats-verification";
import { atsPreviewIdentity } from "./ats-preview";
import { atsImportRecordView, currentAtsImportAuthority, lock } from "./ats-imports";
import { previewApplications, previewJob } from "./ats-connectors/preview";
import {
  boundedAtsRead,
  greenhouseGateway,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";

type Handle = Parameters<typeof authorizedAtsPreview>[0];
type Visible = Parameters<typeof authorizedAtsPreview>[3];
type Allocation = Awaited<ReturnType<typeof authorizedAtsPreview>>;

async function record(h: Handle, scope: WorkflowScope, allocation: Allocation, recordId: string) {
  const [row] = await h
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.id, recordId),
        eq(imports.tenantId, scope.tenantId),
        eq(imports.jobId, scope.jobId),
        eq(imports.accountRef, allocation.binding.accountRef),
        eq(imports.externalJobId, allocation.mapping.externalJobId),
      ),
    );
  if (!row) throw new WorkflowConflict("Imported record not found.", 404);
  return row;
}

async function history(h: Handle, row: typeof imports.$inferSelect): Promise<AtsImportHistory> {
  const items = await h
    .select()
    .from(observations)
    .where(and(eq(observations.tenantId, row.tenantId), eq(observations.recordId, row.id)))
    .orderBy(desc(observations.revision))
    .limit(21);
  return {
    record: atsImportRecordView(row),
    history: [
      {
        revision: 0,
        checkedAt: row.observedAt.toISOString(),
        availability: "unchecked",
        ...row.snapshot,
      },
      ...items.slice(0, 20).map((item) => ({
        revision: item.revision,
        checkedAt: item.checkedAt.toISOString(),
        availability: item.availability,
        ...item.snapshot,
      })),
    ],
    truncated: items.length > 20,
  };
}

export async function readAtsImportHistory(
  scope: WorkflowScope,
  workflowId: string,
  recordId: string,
  visible: Visible,
) {
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, scope, workflowId);
    const allocation = await currentAtsImportAuthority(tx, scope, workflowId, visible);
    return history(tx, await record(tx, scope, allocation, recordId));
  });
}

/** One-record checkpoint. Scheduled calls additionally require a live run fence. */
export async function refreshAtsImport(
  scope: WorkflowScope,
  workflowId: string,
  recordId: string,
  input: AtsRefreshInput,
  visible: Visible,
  gateway: GreenhouseGateway = greenhouseGateway(),
  guard?: (handle: Handle) => Promise<void>,
): Promise<AtsImportHistory> {
  const authorize = async () => {
    await guard?.(dbAdmin);
    return authorizedAtsPreview(dbAdmin, scope, workflowId, visible, input);
  };
  const allocation = await authorize();
  const initial = await record(dbAdmin, scope, allocation, recordId);
  const identity = atsPreviewIdentity(
    scope,
    workflowId,
    input.expectedWorkflowRevision,
    allocation,
  );
  const requestHash = fingerprint({ ...input, actor: scope.actorId, identity, recordId });
  const replay = async (h: Handle) => {
    const [prior] = await h
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.tenantId, scope.tenantId),
          eq(observations.recordId, recordId),
          eq(observations.key, input.idempotencyKey),
        ),
      );
    if (prior && prior.requestHash !== requestHash)
      throw new WorkflowConflict("Refresh key was already used for another request.");
    return Boolean(prior);
  };
  // Key replays are authorized inside the same local fence as history reads.
  if (await replay(dbAdmin)) return readAtsImportHistory(scope, workflowId, recordId, visible);
  if (initial.refreshRevision !== input.expectedRecordRevision)
    throw new WorkflowConflict("Imported metadata changed. Reload before refreshing.");
  const check = async () => {
    const current = await authorize();
    if (atsPreviewIdentity(scope, workflowId, input.expectedWorkflowRevision, current) !== identity)
      throw new WorkflowConflict("ATS authority changed. No refresh was saved.");
    try {
      const available = await boundedAtsRead(gateway.connections());
      if (!available.some((c) => c.id === allocation.binding.connectionId))
        throw new Error("Missing connection");
    } catch {
      throw new WorkflowConflict(
        "Greenhouse authorization is unavailable. No refresh was saved.",
        503,
      );
    }
    await authorize();
  };
  const read = async (path: string) => {
    await check();
    try {
      return await boundedAtsRead(gateway.read(allocation.binding.connectionId, path));
    } catch {
      throw new WorkflowConflict(
        "Greenhouse could not be read. Previous metadata is unchanged.",
        503,
      );
    }
  };
  let job: ReturnType<typeof previewJob>;
  let application: ReturnType<typeof previewApplications>[number] | null;
  try {
    job = previewJob(await read(`/v3/jobs?ids=${initial.externalJobId}`), initial.externalJobId);
    const rows = previewApplications(
      await read(`/v3/applications?ids=${initial.externalApplicationId}`),
      initial.externalJobId,
    );
    if (rows.length > 1) throw new Error("Wrong record count");
    application = rows[0] ?? null;
    if (
      application &&
      (application.id !== initial.externalApplicationId ||
        application.candidateId !== initial.snapshot.application.candidateId)
    )
      throw new WorkflowConflict("External application identity changed. Review its mapping.");
  } catch (error) {
    if (error instanceof WorkflowConflict) throw error;
    throw new WorkflowConflict(
      "Greenhouse returned an invalid or out-of-scope record. No refresh was saved.",
      503,
    );
  }
  await check();
  const checkedAt = new Date();
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, scope, workflowId);
    await guard?.(tx);
    const currentAllocation = await authorizedAtsPreview(tx, scope, workflowId, visible, input);
    if (
      atsPreviewIdentity(scope, workflowId, input.expectedWorkflowRevision, currentAllocation) !==
      identity
    )
      throw new WorkflowConflict("ATS authority changed. No refresh was saved.");
    const current = await record(tx, scope, currentAllocation, recordId);
    if (await replay(tx)) return history(tx, current);
    if (current.refreshRevision !== input.expectedRecordRevision)
      throw new WorkflowConflict("Another refresh completed first. Reload the metadata.");
    const revision = current.refreshRevision + 1;
    const availability = application ? "available" : "unavailable";
    await tx.insert(observations).values({
      id: randomUUID(),
      tenantId: scope.tenantId,
      recordId,
      revision,
      key: input.idempotencyKey,
      requestHash,
      actorId: scope.actorId,
      availability,
      snapshot: { job, application },
      checkedAt,
    });
    const [updated] = await tx
      .update(imports)
      .set({
        refreshRevision: revision,
        availability,
        lastCheckedAt: checkedAt,
        ...(application ? { currentSnapshot: { job, application } } : {}),
      })
      .where(and(eq(imports.id, recordId), eq(imports.tenantId, scope.tenantId)))
      .returning();
    return history(tx, updated);
  });
}
