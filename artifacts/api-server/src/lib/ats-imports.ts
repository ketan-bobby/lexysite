import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  atsImportedApplicationsTable as imports,
  recruitingWorkflowsTable as workflows,
  employerAtsBindingsTable as bindings,
} from "@workspace/db";
import type { AtsImportInput, AtsImportState, AtsImportedRecord } from "@workspace/api-zod";
import { WorkflowConflict, fingerprint, type WorkflowScope } from "./recruiting-workflows";
import { authorizedAtsPreview } from "./ats-verification";
import { atsPreviewIdentity } from "./ats-preview";
import { openPreviewCursor, previewApplications, previewJob } from "./ats-connectors/preview";
import {
  boundedAtsRead,
  greenhouseGateway,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";

type Visible = Parameters<typeof authorizedAtsPreview>[3];
type Handle = Parameters<typeof authorizedAtsPreview>[0];

export function atsImportRecordView(r: typeof imports.$inferSelect): AtsImportedRecord {
  return {
    id: r.id,
    ...(r.currentSnapshot ?? r.snapshot),
    importedAt: r.importedAt.toISOString(),
    observedAt: r.observedAt.toISOString(),
    refreshRevision: r.refreshRevision,
    availability: r.availability,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
  };
}

async function list(
  h: Handle,
  scope: WorkflowScope,
  allocation: Awaited<ReturnType<typeof authorizedAtsPreview>>,
): Promise<AtsImportState> {
  const records = await h
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.tenantId, scope.tenantId),
        eq(imports.jobId, scope.jobId),
        eq(imports.accountRef, allocation.binding.accountRef),
        eq(imports.externalJobId, allocation.mapping.externalJobId),
      ),
    )
    .orderBy(desc(imports.importedAt), desc(imports.id))
    .limit(101);
  return {
    records: records.slice(0, 100).map(atsImportRecordView),
    truncated: records.length > 100,
    importedCount: 0,
    existingCount: 0,
  };
}

export async function readAtsImports(
  scope: WorkflowScope,
  workflowId: string,
  visible: Visible,
): Promise<AtsImportState> {
  // Read current revisions inside the same locked transaction as authorization
  // and imported metadata; never return stored data after local disconnect.
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, scope, workflowId);
    const allocation = await currentAtsImportAuthority(tx, scope, workflowId, visible);
    return list(tx, scope, allocation);
  });
}

export async function currentAtsImportAuthority(
  tx: Handle,
  scope: WorkflowScope,
  workflowId: string,
  visible: Visible,
) {
  const [row] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, scope.tenantId),
        eq(workflows.jobId, scope.jobId),
        eq(workflows.id, workflowId),
      ),
    );
  if (!row) throw new WorkflowConflict("Workflow not found.", 404);
  // Binding revision is server-owned on this read.
  const [binding] = await tx.select().from(bindings).where(eq(bindings.tenantId, scope.tenantId));
  return authorizedAtsPreview(tx, scope, workflowId, visible, {
    expectedWorkflowRevision: row.revision,
    expectedBindingRevision: binding?.revision ?? 0,
  });
}

export async function lock(h: Handle, scope: WorkflowScope, workflowId: string) {
  await h.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${scope.tenantId}`},0))`,
  );
  await h
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.jobId, scope.jobId),
        eq(workflows.tenantId, scope.tenantId),
      ),
    )
    .for("update");
}

/** Atomically import selected, freshly re-read metadata, not native pipeline rows. */
export async function importAtsRecords(
  scope: WorkflowScope,
  workflowId: string,
  input: AtsImportInput,
  visible: Visible,
  gateway: GreenhouseGateway = greenhouseGateway(),
): Promise<AtsImportState> {
  const authorize = () => authorizedAtsPreview(dbAdmin, scope, workflowId, visible, input);
  const initial = await authorize();
  if (
    input.acknowledgeMetadataOnly !== true ||
    !input.applicationIds.length ||
    input.applicationIds.length > 10 ||
    new Set(input.applicationIds).size !== input.applicationIds.length ||
    input.applicationIds.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
  )
    throw new WorkflowConflict(
      "Select up to ten distinct applications and acknowledge metadata intake.",
      400,
    );
  const identity = atsPreviewIdentity(scope, workflowId, input.expectedWorkflowRevision, initial);
  let proof: { jobHash: string; applications: { id: string; hash: string }[]; checkedAt: string };
  try {
    proof = JSON.parse(openPreviewCursor(input.previewToken, `${identity}:import-selection`));
    if (
      !proof ||
      typeof proof.jobHash !== "string" ||
      !Array.isArray(proof.applications) ||
      !Number.isFinite(Date.parse(proof.checkedAt)) ||
      input.applicationIds.some((id) => !proof.applications.some((a) => a.id === id))
    )
      throw new Error("Invalid preview selection");
  } catch {
    throw new WorkflowConflict("Preview expired or selection changed. Reload before importing.");
  }
  const deadline = Date.now() + 25_000;
  const check = async () => {
    const current = await authorize();
    if (atsPreviewIdentity(scope, workflowId, input.expectedWorkflowRevision, current) !== identity)
      throw new WorkflowConflict("The ATS allocation changed. Reload before importing.");
    if (Date.now() >= deadline)
      throw new WorkflowConflict("ATS import timed out. Retry the preview.", 503);
  };
  const read = async (path: string) => {
    await check();
    try {
      const remaining = Math.max(1, Math.min(10_000, deadline - Date.now()));
      return await boundedAtsRead(gateway.read(initial.binding.connectionId, path), remaining);
    } catch {
      throw new WorkflowConflict("Greenhouse is unavailable. Nothing was imported.", 503);
    }
  };
  try {
    const available = await boundedAtsRead(gateway.connections());
    if (!available.some((c) => c.id === initial.binding.connectionId))
      throw new Error("Missing account");
  } catch {
    throw new WorkflowConflict("The authorized Greenhouse connection is unavailable.", 503);
  }
  let job: ReturnType<typeof previewJob>;
  try {
    job = previewJob(
      await read(`/v3/jobs?ids=${initial.mapping.externalJobId}`),
      initial.mapping.externalJobId,
    );
  } catch (error) {
    if (error instanceof WorkflowConflict) throw error;
    throw new WorkflowConflict("The mapped Greenhouse job is unavailable.", 503);
  }
  if (fingerprint(job) !== proof.jobHash)
    throw new WorkflowConflict("The job changed since preview. Reload before importing.");
  const applications: ReturnType<typeof previewApplications> = [];
  for (const id of input.applicationIds) {
    let application: ReturnType<typeof previewApplications>[number];
    try {
      const records = previewApplications(
        await read(`/v3/applications?ids=${id}`),
        initial.mapping.externalJobId,
      );
      if (records.length !== 1 || records[0].id !== id) throw new Error("Wrong application");
      application = records[0];
    } catch (error) {
      if (error instanceof WorkflowConflict) throw error;
      throw new WorkflowConflict(
        "Greenhouse application could not be validated. Nothing was imported.",
        503,
      );
    }
    if (fingerprint(application) !== proof.applications.find((a) => a.id === id)?.hash)
      throw new WorkflowConflict("An application changed since preview. Reload before importing.");
    applications.push(application);
  }
  await check();
  try {
    const available = await boundedAtsRead(gateway.connections());
    if (!available.some((c) => c.id === initial.binding.connectionId))
      throw new Error("Missing account");
  } catch {
    throw new WorkflowConflict(
      "Greenhouse authorization is unavailable. Nothing was imported.",
      503,
    );
  }
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, scope, workflowId);
    const current = await authorizedAtsPreview(tx, scope, workflowId, visible, input);
    if (atsPreviewIdentity(scope, workflowId, input.expectedWorkflowRevision, current) !== identity)
      throw new WorkflowConflict("The ATS allocation changed. Nothing was imported.");
    const existing = await tx
      .select()
      .from(imports)
      .where(
        and(
          eq(imports.tenantId, scope.tenantId),
          eq(imports.accountRef, current.binding.accountRef),
          inArray(imports.externalApplicationId, input.applicationIds),
        ),
      );
    // Import never silently moves an external application between local jobs,
    // remaps it to a different person, or refreshes a historical snapshot.
    if (
      existing.some(
        (r) =>
          r.jobId !== scope.jobId ||
          r.externalJobId !== current.mapping.externalJobId ||
          r.snapshot.application.candidateId !==
            applications.find((a) => a.id === r.externalApplicationId)?.candidateId,
      )
    )
      throw new WorkflowConflict(
        "An external application has a conflicting local mapping. Review it first.",
      );
    const additions = applications.filter(
      (a) => !existing.some((r) => r.externalApplicationId === a.id),
    );
    if (additions.length)
      await tx.insert(imports).values(
        additions.map((application) => ({
          id: randomUUID(),
          tenantId: scope.tenantId,
          jobId: scope.jobId,
          workflowId,
          accountRef: current.binding.accountRef,
          externalJobId: current.mapping.externalJobId,
          externalApplicationId: application.id,
          snapshot: { job, application },
          importedBy: scope.actorId,
          observedAt: new Date(proof.checkedAt),
        })),
      );
    return {
      ...(await list(tx, scope, current)),
      importedCount: additions.length,
      existingCount: existing.length,
    };
  });
}
