import { randomUUID } from "node:crypto";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  dbAdmin,
  employerAtsBindingsTable as bindings,
  atsMappingVerificationsTable as checks,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
  usersTable,
} from "@workspace/db";
import type { AtsVerificationInput, AtsVerificationState } from "@workspace/api-zod";
import { WorkflowConflict, fingerprint, type WorkflowScope } from "./recruiting-workflows";
import { offerAuthority, scopedRow } from "./offer-routing";
import { createGreenhouseRecordReader } from "./ats-connectors/greenhouse";
import { verifyAtsRecordMapping } from "./ats-connectors/records";
import {
  boundedAtsRead,
  greenhouseGateway,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";

type Handle = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0] | typeof dbAdmin;
type Visible = (handle: Handle, candidateId: string) => Promise<boolean>;
type Binding = typeof bindings.$inferSelect;

async function context(h: Handle, scope: WorkflowScope, workflowId: string, visible: Visible) {
  const row = await scopedRow(h, scope, workflowId, visible);
  const [actor] = await h.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
  if (!actor || actor.status !== "active") throw new WorkflowConflict("Unauthorized", 401);
  const authority = await offerAuthority(h, scope, row);
  const canEdit = scope.canEdit !== false;
  const platform = canEdit && actor.role === "platform_admin";
  const employer = canEdit && authority.canConfigure;
  const mapping = row.steps.find((s) => s.key === "hiring_decision")?.atsHandoff?.mapping;
  const canVerify =
    canEdit &&
    authority.config?.mode === "external" &&
    (employer ||
      (authority.config.ownerUserId === scope.actorId &&
        authority.available.some((p) => p.id === scope.actorId)));
  return { row, mapping, platform, employer, canVerify };
}

export async function authorizedAtsPreview(
  h: Handle,
  scope: WorkflowScope,
  workflowId: string,
  visible: Visible,
  input: { expectedWorkflowRevision: number; expectedBindingRevision: number },
) {
  const c = await context(h, scope, workflowId, visible);
  const b = await binding(h, scope.tenantId);
  if (!c.canVerify) throw new WorkflowConflict("Employer handoff authority required.", 403);
  revisions(c, b, { ...input, action: "verify" });
  if (!matching(c, b) || !b || !c.mapping)
    throw new WorkflowConflict("An employer-approved Greenhouse binding is required.");
  return { binding: b, mapping: c.mapping };
}

async function binding(h: Handle, tenantId: string) {
  const [result] = await h.select().from(bindings).where(eq(bindings.tenantId, tenantId));
  return result;
}

async function lock(h: Handle, tenantId: string) {
  await h.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${tenantId}`},0))`,
  );
}

function matching(c: Awaited<ReturnType<typeof context>>, b: Binding | undefined) {
  return Boolean(
    b?.status === "active" &&
    c.mapping?.system.trim().toLowerCase() === "greenhouse" &&
    c.mapping.accountRef === b.accountRef,
  );
}

function revisions(
  c: Awaited<ReturnType<typeof context>>,
  b: Binding | undefined,
  input: AtsVerificationInput,
) {
  if (
    c.row.revision !== input.expectedWorkflowRevision ||
    (b?.revision ?? 0) !== input.expectedBindingRevision
  )
    throw new WorkflowConflict("The workflow or employer binding changed. Reload before acting.");
}

export async function readAtsVerification(
  scope: WorkflowScope,
  workflowId: string,
  visible: Visible,
  gateway: GreenhouseGateway = greenhouseGateway(),
): Promise<AtsVerificationState> {
  const c = await context(dbAdmin, scope, workflowId, visible);
  const b = await binding(dbAdmin, scope.tenantId);
  let connectorStatus: AtsVerificationState["connectorStatus"] = b ? "allocated" : "not_connected";
  let choices: { id: string }[] = [];
  // Only the platform allocator may see project-level connection identifiers.
  if (c.platform) {
    try {
      const available = await boundedAtsRead(gateway.connections());
      // No cross-employer connection metadata is returned to the browser.
      const allocated = await dbAdmin.select().from(bindings);
      choices = available.filter(
        (item) =>
          !allocated.some(
            (allocation) =>
              allocation.connectionId === item.id && allocation.tenantId !== scope.tenantId,
          ) &&
          (!b || item.id === b.connectionId),
      );
      connectorStatus = choices.length ? (b ? "allocated" : "available") : "not_connected";
    } catch {
      connectorStatus = "unavailable";
    }
  }
  const history = await dbAdmin
    .select()
    .from(checks)
    .where(
      and(
        eq(checks.tenantId, scope.tenantId),
        eq(checks.jobId, scope.jobId),
        eq(checks.workflowId, workflowId),
      ),
    )
    .orderBy(desc(checks.checkedAt))
    .limit(20);
  return {
    workflowRevision: c.row.revision,
    bindingRevision: b?.revision ?? 0,
    binding: b
      ? {
          accountRef: b.accountRef,
          revision: b.revision,
          status: b.status,
          updatedAt: b.updatedAt.toISOString(),
        }
      : null,
    canAllocate: c.platform && (!b || b.status === "disconnected"),
    canConfirm: c.employer && b?.status === "pending_employer",
    canDisconnect: Boolean((c.platform || c.employer) && b && b.status !== "disconnected"),
    canVerify: c.canVerify && matching(c, b),
    connectorStatus,
    choices,
    history: history.map((r) => ({
      id: r.id,
      status: r.status,
      checkedAt: r.checkedAt.toISOString(),
      bindingRevision: r.bindingRevision,
      accountRef: r.mapping.accountRef,
      externalJobId: r.mapping.externalJobId,
      externalCandidateId: r.mapping.externalCandidateId,
      externalApplicationId: r.mapping.externalApplicationId,
      currentMapping:
        matching(c, b) &&
        r.bindingRevision === b?.revision &&
        r.workflowRevision === c.row.revision &&
        r.mappingHash === fingerprint(c.mapping),
    })),
  };
}

export async function controlAtsVerification(
  scope: WorkflowScope,
  workflowId: string,
  input: AtsVerificationInput,
  visible: Visible,
  gateway: GreenhouseGateway = greenhouseGateway(),
) {
  // Authorize before connector discovery or receipt lookup.
  const initial = await context(dbAdmin, scope, workflowId, visible);
  if (input.action !== "verify") {
    if (
      (input.action === "allocate" && !initial.platform) ||
      (input.action === "confirm" && !initial.employer) ||
      (input.action === "disconnect" && !initial.platform && !initial.employer)
    )
      throw new WorkflowConflict("Employer or platform administrator authority required.", 403);
    let available: { id: string }[];
    if (input.action === "allocate") {
      if (
        input.acknowledgeEmployerOwnership !== true ||
        !input.connectionId ||
        !input.accountRef?.trim() ||
        input.accountRef !== initial.mapping?.accountRef ||
        initial.mapping?.system.trim().toLowerCase() !== "greenhouse"
      )
        throw new WorkflowConflict(
          "Save the Greenhouse mapping and confirm employer ownership.",
          400,
        );
      try {
        available = await boundedAtsRead(gateway.connections());
      } catch {
        throw new WorkflowConflict("Greenhouse project connections are unavailable.", 503);
      }
      if (!available.some((a) => a.id === input.connectionId))
        throw new WorkflowConflict("Select an available Harvest connection.", 400);
    }
    await dbAdmin.transaction(async (tx) => {
      // Global allocator lock also prevents simultaneous cross-tenant claims.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('ats-allocation',0))`);
      await lock(tx, scope.tenantId);
      await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.tenantId, scope.tenantId),
            eq(workflows.jobId, scope.jobId),
          ),
        )
        .for("update");
      const c = await context(tx, scope, workflowId, visible);
      const b = await binding(tx, scope.tenantId);
      revisions(c, b, input);
      if (input.action === "allocate") {
        if (!c.platform) throw new WorkflowConflict("Platform allocation required.", 403);
        if (b && b.status !== "disconnected")
          throw new WorkflowConflict("Disconnect the current allocation before changing approval.");
        if (b && (b.connectionId !== input.connectionId || b.accountRef !== input.accountRef))
          throw new WorkflowConflict(
            "Account replacement requires a separately reviewed allocation.",
          );
        const [owner] = await tx
          .select()
          .from(bindings)
          .where(eq(bindings.connectionId, input.connectionId!));
        if (owner && owner.tenantId !== scope.tenantId)
          throw new WorkflowConflict("This connection is unavailable for allocation.");
        if (!b) {
          await tx.insert(bindings).values({
            tenantId: scope.tenantId,
            connectionId: input.connectionId!,
            accountRef: input.accountRef!,
            revision: 1,
            status: "pending_employer",
            allocatedBy: scope.actorId,
          });
        } else {
          await tx
            .update(bindings)
            .set({
              status: "pending_employer",
              allocatedBy: scope.actorId,
              confirmedBy: null,
              revision: b.revision + 1,
              updatedAt: new Date(),
            })
            .where(eq(bindings.tenantId, scope.tenantId));
        }
      } else {
        if (!b) throw new WorkflowConflict("No employer allocation exists.");
        if (input.action === "confirm") {
          if (
            !c.employer ||
            input.acknowledgeEmployerOwnership !== true ||
            b.status !== "pending_employer" ||
            b.allocatedBy === scope.actorId
          )
            throw new WorkflowConflict(
              "A separate employer administrator must confirm ownership.",
              403,
            );
        } else if (!c.employer && !c.platform) {
          throw new WorkflowConflict("Administrator authority required.", 403);
        }
        await tx
          .update(bindings)
          .set({
            status: input.action === "confirm" ? "active" : "disconnected",
            confirmedBy: input.action === "confirm" ? scope.actorId : b.confirmedBy,
            revision: b.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(bindings.tenantId, scope.tenantId));
      }
      await tx.insert(events).values({
        tenantId: scope.tenantId,
        jobId: scope.jobId,
        workflowId,
        actorId: scope.actorId,
        action: `ats_binding.${input.action}`,
        note: "Employer allocation control only. No remote writes or offers.",
      });
    });
  } else {
    if (!initial.canVerify) throw new WorkflowConflict("Employer handoff authority required.", 403);
    if (!input.idempotencyKey)
      throw new WorkflowConflict("A verification request key is required.", 400);
    const requestHash = fingerprint({ input, actor: scope.actorId });
    const claim = await dbAdmin.transaction(async (tx) => {
      await lock(tx, scope.tenantId);
      const c = await context(tx, scope, workflowId, visible);
      const b = await binding(tx, scope.tenantId);
      if (!c.canVerify) throw new WorkflowConflict("Employer handoff authority required.", 403);
      const [prior] = await tx
        .select()
        .from(checks)
        .where(
          and(
            eq(checks.tenantId, scope.tenantId),
            eq(checks.workflowId, workflowId),
            eq(checks.key, input.idempotencyKey!),
          ),
        );
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new WorkflowConflict("Request key already used for another verification.");
        return null; // A replay never repeats a remote read, including failed attempts.
      }
      revisions(c, b, input);
      if (!matching(c, b) || !c.mapping || !b)
        throw new WorkflowConflict("An active employer binding matching the mapping is required.");
      const pending = await tx
        .select()
        .from(checks)
        .where(
          and(
            eq(checks.tenantId, scope.tenantId),
            eq(checks.workflowId, workflowId),
            eq(checks.status, "checking"),
          ),
        );
      if (pending.some((p) => Date.now() - p.checkedAt.getTime() < 60_000))
        throw new WorkflowConflict("A verification is already running.");
      for (const p of pending)
        await tx
          .update(checks)
          .set({ status: "discarded" })
          .where(and(eq(checks.id, p.id), eq(checks.tenantId, scope.tenantId)));
      const id = randomUUID();
      await tx.insert(checks).values({
        id,
        tenantId: scope.tenantId,
        jobId: scope.jobId,
        workflowId,
        candidateId: c.row.candidateId,
        actorId: scope.actorId,
        key: input.idempotencyKey!,
        requestHash,
        mappingHash: fingerprint(c.mapping),
        mapping: {
          system: c.mapping.system,
          accountRef: c.mapping.accountRef,
          externalJobId: c.mapping.externalJobId,
          externalCandidateId: c.mapping.externalCandidateId,
          externalApplicationId: c.mapping.externalApplicationId,
        },
        workflowRevision: c.row.revision,
        bindingRevision: b.revision,
        status: "checking",
      });
      return { id, mapping: { ...c.mapping }, b, revision: c.row.revision };
    });
    if (claim) {
      let status: "verified" | "failed" = "failed";
      let stopped = false;
      try {
        const reader = createGreenhouseRecordReader({
          tenantId: scope.tenantId,
          accountRef: claim.b.accountRef,
          async assertCurrentReadGrant() {
            if (stopped) throw new Error("ATS verification stopped");
            const c = await context(dbAdmin, scope, workflowId, visible);
            const b = await binding(dbAdmin, scope.tenantId);
            if (
              stopped ||
              !c.canVerify ||
              !matching(c, b) ||
              b?.revision !== claim.b.revision ||
              c.row.revision !== claim.revision ||
              fingerprint(c.mapping) !== fingerprint(claim.mapping) ||
              !(await gateway.connections()).some((a) => a.id === claim.b.connectionId)
            )
              throw new Error("ATS grant no longer current");
          },
          get: (path) => {
            if (stopped) throw new Error("ATS verification stopped");
            return gateway.read(claim.b.connectionId, path);
          },
        });
        await boundedAtsRead(verifyAtsRecordMapping(scope.tenantId, claim.mapping, reader), 25_000);
        status = "verified";
      } catch {
        // No provider payloads, tokens or private failure causes are persisted.
      } finally {
        stopped = true;
      }
      await dbAdmin.transaction(async (tx) => {
        await lock(tx, scope.tenantId);
        await tx
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.tenantId, scope.tenantId),
              eq(workflows.jobId, scope.jobId),
            ),
          )
          .for("update");
        let current: boolean;
        try {
          const c = await context(tx, scope, workflowId, visible);
          const b = await binding(tx, scope.tenantId);
          current =
            c.canVerify &&
            matching(c, b) &&
            b?.revision === claim.b.revision &&
            c.row.revision === claim.revision &&
            fingerprint(c.mapping) === fingerprint(claim.mapping);
        } catch {
          current = false;
        }
        await tx
          .update(checks)
          .set({ status: current ? status : "discarded", checkedAt: new Date() })
          .where(
            and(
              eq(checks.id, claim.id),
              eq(checks.tenantId, scope.tenantId),
              eq(checks.status, "checking"),
            ),
          );
      });
    }
  }
  return readAtsVerification(scope, workflowId, visible, gateway);
}
