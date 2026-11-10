import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  candidatesTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  type AtsHandoffRecord,
  type AtsRecordMapping,
  type AtsHandoffContent,
} from "@workspace/db";
import type { AtsHandoffInput, AtsHandoffState } from "@workspace/api-zod";
import {
  atomic,
  approvedJob,
  fingerprint,
  readBrief,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { offerAuthority, scopedRow } from "./offer-routing";
import { readRuntimeObservations } from "./workflow-runtime-evidence";
import { redactOfferCapabilities } from "./controlled-offer-view";
import { atsMappingConflicts, atsRecordId } from "./ats-connectors/records";
import { handoffReceipt } from "./ats-handoff-receipt";

type Handle = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0] | typeof dbAdmin;
type Visible = (handle: Handle, candidateId: string) => Promise<boolean>;

async function context(handle: Handle, scope: WorkflowScope, workflowId: string, visible: Visible) {
  const row = await scopedRow(handle, scope, workflowId, visible);
  const authority = await offerAuthority(handle, scope, row);
  const final = row.steps.find((s) => s.key === "hiring_decision")!;
  const config = authority.config;
  const canManage =
    scope.canEdit !== false &&
    (authority.canConfigure ||
      (config?.ownerUserId === scope.actorId &&
        authority.available.some((u) => u.id === scope.actorId)));
  const brief = await readBrief(handle, scope);
  const [journey] = await handle
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, row.journeyId),
        eq(journeys.tenantId, scope.tenantId),
        eq(journeys.jobId, scope.jobId),
      ),
    );
  const blockers: string[] = [];
  if (config?.mode !== "external")
    blockers.push("Select one employer-owned external offer process first.");
  if (config?.ownerUserId && !authority.available.some((u) => u.id === config.ownerUserId))
    blockers.push(
      "The designated employer handoff owner is unavailable; reassign ownership first.",
    );
  if (!approvedJob(brief.job.status)) blockers.push("The work order is not active and approved.");
  if (row.status !== "completed" || row.steps.some((s) => s.status !== "completed"))
    blockers.push("Complete the reviewed recruiting workflow first.");
  if (
    journey?.status !== "approved" ||
    journey.version !== row.journeyVersion ||
    journey.briefHash !== brief.hash
  )
    blockers.push("The journey or approved brief changed; review it first.");
  if (!final?.humanDecision) blockers.push("An explicit human hiring decision is required.");
  if (!canManage)
    blockers.push(
      "Only the employer administrator or designated handoff owner can manage this packet.",
    );
  const [candidate] = await handle
    .select({
      id: candidatesTable.id,
      tenantId: candidatesTable.tenantId,
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
    })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, row.candidateId));
  if (!candidate) throw new WorkflowConflict("Not found", 404);
  const observations = await readRuntimeObservations(handle, scope.jobId, scope.tenantId, [
    { id: candidate.id, tenantId: candidate.tenantId ?? scope.tenantId },
  ]);
  const sorted = observations.sort((a, b) =>
    `${a.stepKey}:${a.sourceType}:${a.sourceId}`.localeCompare(
      `${b.stepKey}:${b.sourceType}:${b.sourceId}`,
    ),
  );
  const makeContent = (mapping: AtsRecordMapping): AtsHandoffContent => ({
    schemaVersion: 1,
    connectionState: "not_connected",
    offerOwner: "external_employer",
    workflowId: row.id,
    journeyVersion: row.journeyVersion,
    briefHash: brief.hash,
    job: { id: scope.jobId, title: brief.job.title },
    candidate: {
      id: candidate.id,
      name: [candidate.firstName, candidate.lastName].filter(Boolean).join(" "),
    },
    mapping,
    decision: {
      ...final.humanDecision!,
      reason: redactOfferCapabilities(final.humanDecision!.reason),
    },
    steps: row.steps.map((s) => ({ key: s.key, label: s.label, status: s.status })),
    // Structured job/identity summaries only. Never raw answers, media, private learning,
    // free-form workflow notes, offer terms or a reusable response capability.
    assessments: sorted.map((o) => ({
      stepKey: o.stepKey,
      sourceType: o.sourceType,
      sourceId: o.sourceId,
      occurredAt: o.occurredAt,
      summary: redactOfferCapabilities(o.summary),
      attentionRequired: o.attentionRequired,
      scope: o.scope,
    })),
    cautions: [
      "Manual export only: no ATS connection, synchronization or external delivery has occurred.",
      "The human decision is hiring intent, not employment, identity clearance or offer approval.",
      "The employer owns final decisions, negotiations and offers; there is no native Lexy offer send path here.",
      "Private learning, raw interview answers, recordings, résumés, contact details and financial offer terms are excluded.",
      ...sorted.filter((o) => o.attentionRequired).map((o) => redactOfferCapabilities(o.summary)),
      ...(final.humanDecision?.testOnly
        ? ["TEST ONLY: fictional workflow evidence is not genuine candidate assessment."]
        : []),
    ],
  });
  const record = final?.atsHandoff;
  const content = record ? makeContent(record.mapping) : null;
  const snapshotHash = content
    ? fingerprint({
        content,
        routing: config,
        // Only the hash is persisted: changed grading/evidence invalidates an older approval.
        evidenceVersions: sorted.map((o) => [o.stepKey, o.sourceType, o.sourceId, o.version]),
      })
    : null;
  return { row, final, config, canManage, blockers, content, snapshotHash, record };
}

export async function readAtsHandoff(
  scope: WorkflowScope,
  id: string,
  visible: Visible,
): Promise<AtsHandoffState> {
  const ctx = await context(dbAdmin, scope, id, visible);
  return {
    connectionState: "not_connected",
    workflowRevision: ctx.row.revision,
    canManage: ctx.canManage,
    ready: ctx.blockers.length === 0,
    blockers: ctx.blockers,
    mapping: ctx.canManage ? (ctx.record?.mapping ?? null) : null,
    packet: ctx.canManage ? (ctx.record?.packet ?? null) : null,
    stale: Boolean(
      ctx.record?.packet &&
      (ctx.record.packet.snapshotHash !== ctx.snapshotHash || ctx.blockers.length),
    ),
  };
}

function cleanId(value: string) {
  try {
    return atsRecordId(value);
  } catch {
    throw new WorkflowConflict(
      "Supply a valid non-empty ATS record identifier, not credentials.",
      400,
    );
  }
}

export async function controlAtsHandoff(
  scope: WorkflowScope,
  workflowId: string,
  input: AtsHandoffInput,
  visible: Visible,
): Promise<AtsHandoffState> {
  await atomic(scope, `ats.handoff_${input.action}`, { ...input, workflowId }, async (tx) => {
    const ctx = await context(tx, scope, workflowId, visible);
    if (!ctx.canManage) throw new WorkflowConflict("Employer handoff authority required.", 403);
    if (ctx.row.revision !== input.expectedRevision)
      throw new WorkflowConflict("Workflow changed. Refresh before continuing.");
    if (ctx.config?.mode !== "external")
      throw new WorkflowConflict("External employer ownership is required.");
    let record: AtsHandoffRecord | undefined = ctx.record;
    let archive = false;
    if (input.action === "save_mapping") {
      if (!input.mapping) throw new WorkflowConflict("Supply the ATS record mapping.", 400);
      const mapping: AtsRecordMapping = {
        system: ctx.config.externalSystem!,
        accountRef: cleanId(input.mapping.accountRef),
        externalJobId: cleanId(input.mapping.externalJobId),
        externalCandidateId: cleanId(input.mapping.externalCandidateId),
        externalApplicationId: cleanId(input.mapping.externalApplicationId),
        mappedBy: scope.actorId,
        mappedAt: new Date().toISOString(),
      };
      // Account-level serialization protects cross-job mapping uniqueness.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-mapping:${scope.tenantId}`},0))`,
      );
      const siblings = await tx
        .select()
        .from(workflows)
        .where(eq(workflows.tenantId, scope.tenantId));
      for (const other of siblings) {
        const m = other.steps.find((s) => s.key === "hiring_decision")?.atsHandoff?.mapping;
        if (!m) continue;
        if (
          atsMappingConflicts(
            {
              tenantId: scope.tenantId,
              workflowId: ctx.row.id,
              jobId: scope.jobId,
              candidateId: ctx.row.candidateId,
              mapping,
            },
            {
              tenantId: other.tenantId,
              workflowId: other.id,
              jobId: other.jobId,
              candidateId: other.candidateId,
              mapping: m,
            },
          )
        )
          throw new WorkflowConflict(
            "ATS mapping conflicts with an existing job, candidate or application in this account.",
          );
      }
      record = { mapping };
      archive = true;
    } else if (input.action === "clear_mapping") {
      if (!input.acknowledgeReview)
        throw new WorkflowConflict(
          "Confirm clearing the local mapping and requiring fresh review.",
          400,
        );
      record = undefined;
      archive = true;
    } else {
      if (ctx.blockers.length) throw new WorkflowConflict(ctx.blockers.join(" "));
      if (!record || !ctx.content || !ctx.snapshotHash)
        throw new WorkflowConflict("Map the ATS records first.");
      if (record.mapping.system.toLowerCase() !== ctx.config.externalSystem!.toLowerCase())
        throw new WorkflowConflict("The external system changed. Save a fresh mapping.");
      if (input.action === "prepare") {
        archive = true;
        record = {
          mapping: record.mapping,
          packet: {
            id: randomUUID(),
            content: ctx.content,
            snapshotHash: ctx.snapshotHash,
            preparedBy: scope.actorId,
            preparedAt: new Date().toISOString(),
          },
        };
      } else {
        const packet = record.packet;
        if (
          !packet ||
          input.packetId !== packet.id ||
          input.snapshotHash !== packet.snapshotHash ||
          packet.snapshotHash !== ctx.snapshotHash
        )
          throw new WorkflowConflict(
            "The packet or evidence changed. Prepare and review a fresh snapshot.",
          );
        if (input.action === "approve") {
          if (!input.acknowledgeReview)
            throw new WorkflowConflict("Confirm reviewing the exact packet and its cautions.", 400);
          record = {
            ...record,
            packet: { ...packet, approvedBy: scope.actorId, approvedAt: new Date().toISOString() },
          };
        } else if (input.action === "record_handoff") {
          record = {
            ...record,
            packet: { ...packet, handoffReceipt: handoffReceipt(packet, input, scope.actorId) },
          };
        } else {
          if (!packet.approvedBy || !packet.approvedAt)
            throw new WorkflowConflict("Approve the reviewed packet before export.");
          record = {
            ...record,
            packet: { ...packet, exportedBy: scope.actorId, exportedAt: new Date().toISOString() },
          };
        }
      }
    }
    const steps = ctx.row.steps.map((s) =>
      s.key !== "hiring_decision"
        ? s
        : {
            ...s,
            atsHandoff: record,
            ...(archive && ctx.record?.packet
              ? { atsHandoffHistory: [...(s.atsHandoffHistory ?? []), ctx.record] }
              : {}),
          },
    );
    await tx
      .update(workflows)
      .set({ steps, revision: ctx.row.revision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(workflows.id, ctx.row.id),
          eq(workflows.tenantId, scope.tenantId),
          eq(workflows.jobId, scope.jobId),
        ),
      );
    return {
      id: ctx.row.id,
      workflowId: ctx.row.id,
      note: `Local ATS handoff ${input.action}; packet ${record?.packet?.id ?? "none"}; snapshot ${record?.packet?.snapshotHash ?? "none"}. Not connected; no ATS API call, native offer, employment or fee action.`,
    };
  });
  const state = await readAtsHandoff(scope, workflowId, visible);
  if (input.action === "export") {
    const packet = state.packet;
    // A replay cannot disclose an older result after ownership, privacy or evidence changed.
    if (
      !state.canManage ||
      !state.ready ||
      state.stale ||
      !packet ||
      packet.id !== input.packetId ||
      !packet.approvedAt ||
      !packet.exportedAt
    )
      throw new WorkflowConflict("Export is no longer current or authorized.");
    return { ...state, exportPacket: packet };
  }
  return state;
}
