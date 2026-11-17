import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  dbAdmin,
  jobsTable,
  usersTable,
  recruitingWorkflowsTable as workflows,
  auditLogsTable,
} from "@workspace/db";
import type { GreenhouseOfferWorkspace, GreenhouseOfferWorkspaceInput } from "@workspace/api-zod";
import { atsHandoffContext } from "./ats-handoff";
import { WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import {
  offerDigest,
  offerRevision,
  offerBlocker,
  offerSnapshotSchema,
  type OfferSnapshot,
} from "./ats-connectors/greenhouse-offer-policy";
import {
  greenhouseOfferControls,
  type OfferControlProvider,
} from "./ats-connectors/greenhouse-offer-controls";
import { greenhouseOfferStore } from "./ats-connectors/greenhouse-offer-store";
import type { greenhouseControlledOfferAssembly } from "./ats-connectors/greenhouse-offer-assembly";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Tx | typeof dbAdmin;
type Visible = (handle: Handle, candidateId: string) => Promise<boolean>;
type Context = Awaited<ReturnType<typeof atsHandoffContext>>;
type VerifiedEvidence = Pick<
  OfferSnapshot,
  | "connectionRevision"
  | "contract"
  | "existingChain"
  | "existingApprovalState"
  | "writePermissionConfirmed"
  | "canReadRemote"
>;
export interface GreenhouseOfferEvidence {
  /** Server-owned evidence only. Must retain employer/custody authority for a fenced operation. */
  resolve(handle: Handle, scope: WorkflowScope, context: Context): Promise<VerifiedEvidence | null>;
}
const proposalSchema = z.strictObject({
  openingId: offerSnapshotSchema.shape.openingId,
  startDate: offerSnapshotSchema.shape.startDate,
  approverId: z.string().min(1).max(200),
  submitterId: z.string().min(1).max(200),
  values: offerSnapshotSchema.shape.values.refine((v) => Object.keys(v).length <= 100),
});
const unresolved = new Set([
  "claimed",
  "draft_created",
  "provider_accepted",
  "review_required",
  "observed_match",
  "observed_other",
]);
const unavailable =
  "Employer-specific Greenhouse configuration and submission permissions are not verified. Nothing can be submitted.";
const conflict = (message: string, status = 409): never => {
  throw new WorkflowConflict(message, status);
};

/** Default is unavailable. A controlled assembly requires explicit server-owned custody/review readers. */
export function greenhouseOfferWorkspace({
  database = dbAdmin,
  evidence,
  simulation,
  controlled,
}: {
  database?: typeof dbAdmin;
  evidence?: GreenhouseOfferEvidence;
  simulation?: OfferControlProvider;
  controlled?: ReturnType<typeof greenhouseControlledOfferAssembly>;
} = {}) {
  if (simulation && controlled)
    throw new Error("Choose exactly one Greenhouse execution provider.");
  const store = greenhouseOfferStore(database);
  async function context(handle: Handle, scope: WorkflowScope, id: string, visible: Visible) {
    const ctx = await atsHandoffContext(handle, scope, id, visible, false);
    const draft = ctx.final?.greenhouseOfferProposal;
    const active = ctx.authority.available.some((u) => u.id === scope.actorId);
    const designated =
      active &&
      [ctx.config?.ownerUserId, draft?.approverId, draft?.submitterId].includes(scope.actorId);
    if (!designated && !ctx.authority.canConfigure)
      conflict("Only designated employer HR staff can read this financial workspace.", 403);
    if (
      ctx.config?.mode !== "external" ||
      ctx.config.externalSystem?.trim().toLowerCase() !== "greenhouse" ||
      ctx.record?.mapping.system.trim().toLowerCase() !== "greenhouse"
    )
      conflict("Greenhouse offer workspace not found.", 404);
    const blockers = [...ctx.blockers];
    if (ctx.final.humanDecision?.outcome !== "hire")
      blockers.push("A current explicit human Hire decision is required.");
    const packet = ctx.record?.packet;
    if (!packet?.approvedAt || !packet.exportedAt || packet.snapshotHash !== ctx.snapshotHash)
      blockers.push("Approve and export the current employer handoff packet first.");
    const localRevision = offerDigest({
      workflowRevision: ctx.row.revision,
      contextHash: ctx.snapshotHash,
      draft: draft ?? null,
      routing: ctx.config,
    });
    const actor = { id: scope.actorId, tenantId: scope.tenantId };
    const journal = await store.inspect(actor, { workflowId: id });
    return {
      ...ctx,
      draft,
      active,
      designated,
      blockers,
      localRevision,
      latest: journal.latest,
      history: journal.history,
      actor,
    };
  }
  type WorkspaceContext = Awaited<ReturnType<typeof context>>;
  function editing(ctx: WorkspaceContext, scope: WorkflowScope) {
    return (
      ctx.active &&
      scope.canEdit !== false &&
      ctx.config?.ownerUserId === scope.actorId &&
      !ctx.blockers.length &&
      !unresolved.has(ctx.latest?.state ?? "")
    );
  }
  async function snapshot(
    handle: Handle,
    scope: WorkflowScope,
    ctx: WorkspaceContext,
  ): Promise<OfferSnapshot | null> {
    const proof = await evidence?.resolve(handle, scope, ctx);
    if (!proof || !ctx.draft) return null;
    const mapping = ctx.record!.mapping;
    return offerSnapshotSchema.parse({
      ...proof,
      actor: ctx.actor,
      scope: { workflowId: ctx.row.id },
      accountRef: offerDigest(mapping.accountRef),
      binding: {
        applicationId: mapping.externalApplicationId,
        candidateId: mapping.externalCandidateId,
        jobId: mapping.externalJobId,
      },
      sourceRevision: offerDigest({
        draft: ctx.draft,
        contextHash: ctx.snapshotHash,
        routing: ctx.config,
        executionMode: controlled ? "controlled" : simulation ? "simulated" : "unavailable",
      }),
      termsOwnerId: ctx.config!.ownerUserId,
      approverId: ctx.draft.approverId,
      submitterId: ctx.draft.submitterId,
      currentHumanDecision:
        !ctx.blockers.length &&
        ctx.draft.contextHash === ctx.snapshotHash &&
        [ctx.draft.approverId, ctx.draft.submitterId].every((id) =>
          ctx.authority.available.some((u) => u.id === id),
        ),
      openingId: ctx.draft.openingId,
      startDate: ctx.draft.startDate,
      values: ctx.draft.values,
    });
  }
  async function view(
    handle: Handle,
    scope: WorkflowScope,
    id: string,
    visible: Visible,
  ): Promise<GreenhouseOfferWorkspace> {
    const ctx = await context(handle, scope, id, visible);
    const s = await snapshot(handle, scope, ctx);
    const blockers = [...ctx.blockers];
    if (!ctx.draft) blockers.push("Save a human-authored local proposal first.");
    if (ctx.draft && ctx.draft.contextHash !== ctx.snapshotHash)
      blockers.push("The reviewed workflow changed. Review and save the proposal again.");
    if (!s || (!simulation && !controlled)) blockers.push(unavailable);
    if (s) {
      const reason = offerBlocker(s, Date.now());
      if (reason) blockers.push(`Employer offer requirements are not satisfied: ${reason}.`);
    }
    const revision = s ? offerRevision(s) : null;
    const currentAttempt = ctx.latest?.revision === revision;
    const ready = !blockers.length && scope.canEdit !== false && ctx.active;
    return {
      history: ctx.history,
      workflowRevision: ctx.row.revision,
      localRevision: ctx.localRevision,
      proposal: ctx.draft
        ? proposalSchema.parse({
            openingId: ctx.draft.openingId,
            startDate: ctx.draft.startDate,
            approverId: ctx.draft.approverId,
            submitterId: ctx.draft.submitterId,
            values: ctx.draft.values,
          })
        : null,
      people: ctx.authority.available.map((u) => ({ id: u.id, name: u.name ?? "Staff member" })),
      canEdit: editing(ctx, scope),
      canApprove:
        ready &&
        currentAttempt &&
        ctx.latest?.state === "prepared" &&
        ctx.draft?.approverId === scope.actorId,
      canSubmit:
        ready &&
        currentAttempt &&
        ctx.latest?.state === "approved" &&
        ctx.draft?.submitterId === scope.actorId,
      blockers,
      controlRevision: revision,
      attempt: ctx.latest
        ? {
            id: ctx.latest.id,
            revision: ctx.latest.revision,
            state: ctx.latest.state,
          }
        : null,
      executionMode: controlled ? "controlled" : simulation ? "simulated" : "unavailable",
    };
  }
  async function fenced<T>(
    scope: WorkflowScope,
    id: string,
    visible: Visible,
    work: (tx: Tx, ctx: WorkspaceContext) => Promise<T>,
  ) {
    return database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recruiting-workflow:${scope.jobId}`},0))`,
      );
      await tx
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)))
        .for("update");
      const first = await context(tx, scope, id, visible);
      await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          inArray(usersTable.id, [
            scope.actorId,
            first.config!.ownerUserId!,
            first.draft?.approverId ?? scope.actorId,
            first.draft?.submitterId ?? scope.actorId,
          ]),
        )
        .for("update");
      await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.id, id),
            eq(workflows.jobId, scope.jobId),
            eq(workflows.tenantId, scope.tenantId),
          ),
        )
        .for("update");
      return work(tx, await context(tx, scope, id, visible));
    });
  }
  return {
    read: (scope: WorkflowScope, id: string, visible: Visible) =>
      view(database, scope, id, visible),
    async control(
      scope: WorkflowScope,
      id: string,
      input: GreenhouseOfferWorkspaceInput,
      visible: Visible,
    ) {
      if (input.confirm !== true) conflict("Explicit human confirmation is required.", 400);
      z.uuid().parse(input.idempotencyKey);
      const initial = await context(database, scope, id, visible);
      const assertCurrent = (ctx: WorkspaceContext) => {
        if (ctx.localRevision !== input.expectedLocalRevision)
          conflict("This financial workspace changed. Reload and review the saved proposal.");
      };
      if (input.action === "save") {
        if (!input.proposal || input.attemptId || input.expectedControlRevision)
          conflict("Supply only the local financial proposal for saving.", 400);
        const proposal = proposalSchema.parse(input.proposal);
        const requestHash = offerDigest({ input, actorId: scope.actorId });
        await fenced(scope, id, visible, async (tx, ctx) => {
          if (
            ctx.draft?.saveRequestId === input.idempotencyKey &&
            ctx.draft.savedBy === scope.actorId
          ) {
            if (ctx.draft.saveRequestHash !== requestHash) conflict("Request key reused.");
            return;
          }
          assertCurrent(ctx);
          if (!editing(ctx, scope))
            conflict("The current employer owner must review this proposal.", 403);
          for (const person of [proposal.approverId, proposal.submitterId])
            if (!ctx.authority.available.some((u) => u.id === person))
              conflict("Select active employer staff with work-order access.", 400);
          const steps = structuredClone(ctx.row.steps);
          const decision = steps.find((step) => step.key === "hiring_decision")!;
          if (ctx.draft) {
            decision.greenhouseOfferProposalHistory = [
              ...(decision.greenhouseOfferProposalHistory ?? []),
              structuredClone(ctx.draft),
            ];
          }
          decision.greenhouseOfferProposal = {
            ...proposal,
            version: (ctx.draft?.version ?? 0) + 1,
            contextHash: ctx.snapshotHash!,
            savedBy: scope.actorId,
            savedAt: new Date().toISOString(),
            saveRequestId: input.idempotencyKey,
            saveRequestHash: requestHash,
          };
          await tx
            .update(workflows)
            .set({
              steps,
              revision: ctx.row.revision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(workflows.id, id),
                eq(workflows.jobId, scope.jobId),
                eq(workflows.tenantId, scope.tenantId),
              ),
            );
          await tx.insert(auditLogsTable).values({
            id: randomUUID(),
            tenantId: scope.tenantId,
            actorId: scope.actorId,
            actorType: "user",
            subjectType: "external",
            subjectId: id,
            action: "greenhouse.offer_proposal_saved",
            channel: "system",
            direction: "internal",
            title: "Human Greenhouse proposal saved locally; nothing submitted",
            metadata: {
              revision: offerDigest(
                steps.find((step) => step.key === "hiring_decision")!.greenhouseOfferProposal,
              ),
            },
          });
        });
      } else {
        assertCurrent(initial);
        if (input.proposal) conflict("Financial edits require a separate local save.", 400);
        if (!simulation && !controlled) conflict(unavailable);
        const source = {
          current: async () => {
            const ctx = await context(database, scope, id, visible);
            assertCurrent(ctx);
            return (await snapshot(database, scope, ctx)) ?? conflict(unavailable);
          },
          fence: async <T>(
            _actor: unknown,
            _offerScope: unknown,
            work: (s: OfferSnapshot) => Promise<T>,
          ) =>
            fenced(scope, id, visible, async (tx, ctx) => {
              assertCurrent(ctx);
              return work((await snapshot(tx, scope, ctx)) ?? conflict(unavailable));
            }),
        };
        const core = controlled
          ? controlled(source, store)
          : greenhouseOfferControls({
              source,
              store,
              provider: simulation!,
              newId: randomUUID,
            });
        const actor = { id: scope.actorId, tenantId: scope.tenantId };
        const target = { workflowId: id };
        const command = {
          expectedRevision: input.expectedControlRevision ?? "",
          requestId: input.idempotencyKey,
          confirm: true as const,
        };
        if (input.action === "prepare") {
          if (input.attemptId) conflict("Preparation does not accept an existing attempt.", 400);
          await core.prepare(actor, target, command);
        } else {
          if (!input.attemptId) conflict("Choose the exact saved offer attempt.", 400);
          if (input.action === "approve")
            await core.approve(actor, target, input.attemptId!, command);
          else if (input.action === "submit")
            await core.submit(actor, target, input.attemptId!, command);
          else if (input.action === "recover") await core.recover(actor, target, input.attemptId!);
          else conflict("Unknown offer action.", 400);
        }
      }
      return view(database, scope, id, visible);
    },
  };
}
