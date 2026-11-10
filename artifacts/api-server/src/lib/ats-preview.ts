import { and, eq, sql } from "drizzle-orm";
import { dbAdmin, recruitingWorkflowsTable as workflows } from "@workspace/db";
import type { AtsPreviewInput, AtsPreviewPage } from "@workspace/api-zod";
import { WorkflowConflict, fingerprint, type WorkflowScope } from "./recruiting-workflows";
import { authorizedAtsPreview } from "./ats-verification";
import {
  applicationPreviewPath,
  boundedAtsRead,
  greenhouseGateway,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";
import {
  previewJob,
  previewApplications,
  sealPreviewCursor,
  openPreviewCursor,
} from "./ats-connectors/preview";

type Visible = Parameters<typeof authorizedAtsPreview>[3];

export function atsPreviewIdentity(
  scope: WorkflowScope,
  workflowId: string,
  workflowRevision: number,
  allocation: Awaited<ReturnType<typeof authorizedAtsPreview>>,
) {
  return fingerprint({
    actor: scope.actorId,
    tenant: scope.tenantId,
    job: scope.jobId,
    workflowId,
    bindingRevision: allocation.binding.revision,
    workflowRevision,
    mapping: allocation.mapping,
    connectionId: allocation.binding.connectionId,
  });
}

/** Transient, explicit staff preview. No imports, persistence or external writes. */
export async function previewAtsRecords(
  scope: WorkflowScope,
  workflowId: string,
  input: AtsPreviewInput,
  visible: Visible,
  gateway: GreenhouseGateway = greenhouseGateway(),
): Promise<AtsPreviewPage> {
  const authorize = () => authorizedAtsPreview(dbAdmin, scope, workflowId, visible, input);
  const initial = await authorize();
  const identity = atsPreviewIdentity(scope, workflowId, input.expectedWorkflowRevision, initial);
  let cursor: string | undefined;
  try {
    cursor = input.cursor ? openPreviewCursor(input.cursor, identity) : undefined;
  } catch {
    throw new WorkflowConflict("Preview expired or changed. Reload the first page.", 409);
  }
  const check = async () => {
    const current = await authorize();
    if (
      current.binding.connectionId !== initial.binding.connectionId ||
      fingerprint(current.mapping) !== fingerprint(initial.mapping)
    )
      throw new WorkflowConflict("The Greenhouse mapping changed. Reload the preview.");
    let available: { id: string }[];
    try {
      available = await boundedAtsRead(gateway.connections());
    } catch {
      throw new WorkflowConflict("Greenhouse is unavailable. Retry the preview.", 503);
    }
    if (!available.some((c) => c.id === initial.binding.connectionId))
      throw new WorkflowConflict("The authorized Greenhouse connection is unavailable.", 503);
    await authorize();
  };
  const jobId = initial.mapping.externalJobId;
  let job: AtsPreviewPage["job"];
  let applications: AtsPreviewPage["applications"];
  let nextCursor: string | null;
  await check();
  try {
    if (!gateway.page) throw new Error("Preview transport unavailable");
    // Re-read the exact job even for continuation pages: never rely on a stale
    // first-page permission or disclose legacy confidential requisitions.
    job = previewJob(
      await boundedAtsRead(gateway.read(initial.binding.connectionId, `/v3/jobs?ids=${jobId}`)),
      jobId,
    );
  } catch {
    throw new WorkflowConflict("The mapped Greenhouse job could not be previewed.", 503);
  }
  await check();
  try {
    const page = await boundedAtsRead(
      gateway.page!(initial.binding.connectionId, applicationPreviewPath(jobId, cursor)),
    );
    applications = previewApplications(page.records, jobId);
    nextCursor = page.nextCursor ? sealPreviewCursor(page.nextCursor, identity) : null;
  } catch {
    throw new WorkflowConflict("Greenhouse applications could not be previewed. Retry.", 503);
  }
  await check();
  // Same locks as binding/workflow mutations: recheck local authority at the
  // final response fence. Nothing is stored, including raw provider profiles.
  await dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${scope.tenantId}`},0))`,
    );
    await tx
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
    await authorizedAtsPreview(tx, scope, workflowId, visible, input);
  });
  const checkedAt = new Date().toISOString();
  const previewToken = sealPreviewCursor(
    JSON.stringify({
      jobHash: fingerprint(job),
      applications: applications.map((a) => ({ id: a.id, hash: fingerprint(a) })),
      checkedAt,
    }),
    `${identity}:import-selection`,
  );
  return { job, applications, nextCursor, checkedAt, previewToken };
}
