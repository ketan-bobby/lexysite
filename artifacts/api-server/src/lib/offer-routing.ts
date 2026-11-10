import { and, eq, inArray, ne } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  usersTable,
  candidatesTable,
  recruitingWorkflowsTable as workflows,
  recruitingJourneysTable as journeys,
  type OfferRoutingConfiguration,
} from "@workspace/db";
import type { OfferRoutingInput, OfferRoutingState } from "@workspace/api-zod";
import {
  atomic,
  readBrief,
  approvedJob,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { offerView } from "./controlled-offer-view";
import { recruiterIsAssignedToJob, getDataScopeTenantIds } from "./tenantUtils";

type Handle = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0] | typeof dbAdmin;
type Row = typeof workflows.$inferSelect;
type Visible = (handle: Handle, candidateId: string) => Promise<boolean>;
const staffRoles = ["tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"] as const;
const offerRoles = [
  ["owner", "ownerUserId"],
  ["approver", "approverUserId"],
  ["sender", "senderUserId"],
] as const;

async function people(handle: Handle, scope: WorkflowScope) {
  const [job] = await handle
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)));
  if (!job) throw new WorkflowConflict("Not found", 404);
  const staff = await handle
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.tenantId, scope.tenantId),
        eq(usersTable.status, "active"),
        inArray(usersTable.role, [...staffRoles]),
      ),
    );
  const checks = await Promise.all(
    staff.map(async (user) => {
      const allowed = await getDataScopeTenantIds(user);
      if (allowed !== null && !allowed.includes(scope.tenantId)) return false;
      if (user.role === "hiring_manager") return job.assignedHiringManagerId === user.id;
      if (user.role === "recruiter") return recruiterIsAssignedToJob(user.id, job);
      return true;
    }),
  );
  return staff.filter((_, i) => checks[i]);
}

export async function offerAuthority(
  handle: Handle,
  scope: WorkflowScope,
  row: Row,
  currentEligibleStaff?: Awaited<ReturnType<typeof people>>,
) {
  const [actor] = await handle.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
  const canConfigure =
    actor?.status === "active" &&
    actor.role === "tenant_admin" &&
    actor.tenantId === scope.tenantId;
  const available = currentEligibleStaff ?? (await people(handle, scope));
  const config = row.steps.find((s) => s.key === "hiring_decision")?.offerRouting;
  const assigned = (id: string | null | undefined) =>
    Boolean(id && id === scope.actorId && available.some((user) => user.id === id));
  const native = config?.mode === "native" && scope.canEdit !== false;
  const canManageTerms = Boolean(native && assigned(config?.ownerUserId));
  const canApprove = Boolean(native && assigned(config?.approverUserId));
  const canSend = Boolean(native && assigned(config?.senderUserId));
  return {
    config,
    available,
    canConfigure,
    canManageTerms,
    canApprove,
    canSend,
    canWithdraw: canManageTerms || canApprove || canSend,
  };
}

export async function scopedRow(
  handle: Handle,
  scope: WorkflowScope,
  id: string,
  visible: Visible,
) {
  const [row] = await handle
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, id),
        eq(workflows.jobId, scope.jobId),
        eq(workflows.tenantId, scope.tenantId),
      ),
    );
  if (!row || !(await visible(handle, row.candidateId)))
    throw new WorkflowConflict("Not found", 404);
  return row;
}

/** Recovery changes designation, never terms, delivery claims, workflow state or evidence. */
function ownershipRecovery(row: Row, authority: Awaited<ReturnType<typeof offerAuthority>>) {
  const offer = row.steps.find((s) => s.key === "hiring_decision")?.controlledOffer;
  const config = authority.config;
  if (
    !offer ||
    config?.mode !== "native" ||
    ["withdrawn", "expired"].includes(offerView(offer).status)
  )
    return null;
  const unavailableRoles = offerRoles
    .filter(([, field]) => !authority.available.some((u) => u.id === config[field]))
    .map(([role]) => role);
  if (!unavailableRoles.length) return null;
  const blockers: string[] = [];
  if (["sending", "send_uncertain"].includes(offer.status))
    blockers.push(
      "Delivery is in flight or uncertain. Reconcile the original attempt; recovery cannot release or retry its claim.",
    );
  if (
    ["draft", "review_required", "approved"].includes(offer.status) &&
    (offer.sentAt || offer.deliveryStartedAt || offer.deliveryReceiptId || offer.tokenHash)
  )
    blockers.push(
      "Unsent status conflicts with recorded delivery evidence. Reconcile it before changing ownership.",
    );
  return {
    unavailableRoles,
    blockers,
    canRecover: authority.canConfigure && !blockers.length,
    resetsApproval: ["review_required", "approved"].includes(offer.status),
  };
}

export async function readOfferRouting(
  scope: WorkflowScope,
  workflowId: string,
  visible: Visible,
): Promise<OfferRoutingState> {
  const row = await scopedRow(dbAdmin, scope, workflowId, visible);
  const authority = await offerAuthority(dbAdmin, scope, row);
  const final = row.steps.find((s) => s.key === "hiring_decision");
  const decision = final?.humanDecision;
  const [candidate] = await dbAdmin
    .select({
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
    })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, row.candidateId));
  const name = (id: string | null | undefined) =>
    authority.available.find((u) => u.id === id)?.name ?? null;
  const config = authority.config;
  const brief = await readBrief(dbAdmin, scope);
  const [journey] = await dbAdmin
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, row.journeyId),
        eq(journeys.jobId, scope.jobId),
        eq(journeys.tenantId, scope.tenantId),
      ),
    );
  const currentDecision =
    approvedJob(brief.job.status) &&
    journey?.status === "approved" &&
    journey.version === row.journeyVersion &&
    journey.briefHash === brief.hash;
  return {
    recovery: ownershipRecovery(row, authority),
    configuration: config ?? null,
    workflowRevision: row.revision,
    canConfigure: authority.canConfigure,
    canManageTerms: authority.canManageTerms,
    canApprove: authority.canApprove,
    canSend: authority.canSend,
    canWithdraw: authority.canWithdraw,
    people: authority.canConfigure
      ? authority.available.map((u) => ({ id: u.id, name: u.name }))
      : [],
    ownerName: name(config?.ownerUserId),
    approverName: name(config?.approverUserId),
    senderName: name(config?.senderUserId),
    handoffStatus: !config
      ? "unconfigured"
      : config.mode === "native"
        ? "native"
        : !decision
          ? "awaiting_hiring_decision"
          : decision.outcome !== "hire"
            ? "paused"
            : row.status === "completed" && currentDecision
              ? "awaiting_employer"
              : "awaiting_hiring_decision",
    packet: decision
      ? {
          candidateName: [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" "),
          decision: decision.outcome,
          decisionBy: decision.actorName,
          decisionAt: decision.decidedAt,
          decisionReason: decision.reason,
          testOnly: decision.testOnly,
          evidence: row.steps.map((s) => ({
            label: s.label,
            status: s.status,
            evidence: s.evidence,
          })),
        }
      : null,
  };
}

export async function configureOfferRouting(
  scope: WorkflowScope,
  workflowId: string,
  input: OfferRoutingInput,
  visible: Visible,
) {
  const recovering = input.acknowledgeOwnershipRecovery === true;
  await atomic(
    scope,
    recovering ? "offer.routing_recovered" : "offer.routing_configured",
    { ...input, workflowId },
    async (tx) => {
      const row = await scopedRow(tx, scope, workflowId, visible);
      const authority = await offerAuthority(tx, scope, row);
      if (!authority.canConfigure)
        throw new WorkflowConflict(
          "Only this employer's tenant administrator may assign offer authority.",
          403,
        );
      if (row.revision !== input.expectedRevision)
        throw new WorkflowConflict("Workflow changed. Refresh before configuring offer ownership.");
      const siblings = await tx
        .select({ id: workflows.id, steps: workflows.steps })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenantId, scope.tenantId),
            eq(workflows.jobId, scope.jobId),
            eq(workflows.candidateId, row.candidateId),
            ne(workflows.id, row.id),
          ),
        );
      if (
        siblings.some((other) =>
          other.steps.some(
            (s) =>
              s.offerRouting ||
              (s.controlledOffer &&
                !["withdrawn", "expired"].includes(offerView(s.controlledOffer).status)),
          ),
        )
      )
        throw new WorkflowConflict(
          "This application already has an offer process on another workflow. Continue with that workflow instead of creating a competing offer process.",
        );
      const step = row.steps.find((s) => s.key === "hiring_decision");
      if (!step) throw new WorkflowConflict("Not found", 404);
      const currentOffer = step.controlledOffer;
      const blockedOffer =
        currentOffer && !["withdrawn", "expired"].includes(offerView(currentOffer).status);
      const legacyAdoption =
        blockedOffer &&
        !step.offerRouting &&
        input.mode === "native" &&
        input.acknowledgeExistingOffer === true &&
        currentOffer.status !== "sending";
      const recovery = ownershipRecovery(row, authority);
      if (recovering) {
        if (input.reason.trim().length < 10)
          throw new WorkflowConflict(
            "Write a recovery reason of at least 10 non-padding characters.",
            400,
          );
        if (input.acknowledgeExistingOffer)
          throw new WorkflowConflict(
            "Legacy adoption and ownership recovery are separate actions.",
            400,
          );
        if (!recovery?.canRecover)
          throw new WorkflowConflict(
            recovery?.blockers.join(" ") ||
              "Recovery requires an existing native offer and an unavailable designated staff member.",
          );
        if (input.mode !== "native")
          throw new WorkflowConflict("Recovery cannot switch the employer offer process.", 400);
        for (const [, field] of offerRoles) {
          const previousId = authority.config![field];
          if (authority.available.some((u) => u.id === previousId) && input[field] !== previousId)
            throw new WorkflowConflict(
              "Keep every available assignee unchanged. Recovery replaces only unavailable staff.",
            );
        }
      }
      if (blockedOffer && !legacyAdoption && !recovering)
        throw new WorkflowConflict(
          "Explicitly withdraw the existing offer before changing ownership. A legacy native offer may instead be explicitly adopted with unchanged delivered terms and fresh review of unsent approvals.",
        );
      const config: OfferRoutingConfiguration = {
        mode: input.mode,
        ownerUserId: input.ownerUserId || null,
        approverUserId: input.approverUserId || null,
        senderUserId: input.senderUserId || null,
        externalSystem: input.externalSystem?.trim() || null,
        externalApplicationUrl: input.externalApplicationUrl?.trim() || null,
        configuredBy: scope.actorId,
        configuredAt: new Date().toISOString(),
      };
      if (config.mode === "native") {
        if (
          !config.ownerUserId ||
          !config.approverUserId ||
          !config.senderUserId ||
          config.externalSystem ||
          config.externalApplicationUrl
        )
          throw new WorkflowConflict(
            "Native offers require an explicit owner, approver and sender, without an external process.",
            400,
          );
      } else {
        if (!config.externalSystem || config.approverUserId || config.senderUserId)
          throw new WorkflowConflict(
            "External offers require a named employer process and no native approval or send authority.",
            400,
          );
        if (config.externalApplicationUrl) {
          let url: URL;
          try {
            url = new URL(config.externalApplicationUrl);
          } catch {
            throw new WorkflowConflict("Use a valid HTTPS application link.", 400);
          }
          if (url.protocol !== "https:" || url.username || url.password)
            throw new WorkflowConflict(
              "Use an HTTPS application link without embedded credentials.",
              400,
            );
        }
      }
      for (const id of [config.ownerUserId, config.approverUserId, config.senderUserId].filter(
        Boolean,
      )) {
        if (!authority.available.some((user) => user.id === id))
          throw new WorkflowConflict(
            "Offer assignee is not an active, eligible member of this employer.",
            404,
          );
      }
      const resetApproval =
        (legacyAdoption || recovering) &&
        currentOffer &&
        ["approved", "review_required"].includes(currentOffer.status);
      const adoptedOffer = resetApproval
        ? { ...currentOffer, status: "draft" as const }
        : currentOffer;
      if (resetApproval && adoptedOffer) {
        delete adoptedOffer.approvedBy;
        delete adoptedOffer.approvedAt;
      }
      await tx
        .update(workflows)
        .set({
          steps: row.steps.map((s) =>
            s.key === step.key
              ? {
                  ...s,
                  offerRouting: config,
                  offerRoutingHistory: [
                    ...(s.offerRoutingHistory ?? []),
                    ...(s.offerRouting ? [s.offerRouting] : []),
                  ],
                  ...(legacyAdoption || recovering ? { controlledOffer: adoptedOffer } : {}),
                  ...(resetApproval
                    ? {
                        controlledOfferHistory: [
                          ...(s.controlledOfferHistory ?? []),
                          currentOffer!,
                        ],
                      }
                    : {}),
                }
              : s,
          ),
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflows.id, row.id),
            eq(workflows.jobId, scope.jobId),
            eq(workflows.tenantId, scope.tenantId),
          ),
        );
      return {
        id: row.id,
        workflowId: row.id,
        note: `Employer selected ${config.mode} offer ownership: owner=${config.ownerUserId ?? "external employer"}, approver=${config.approverUserId ?? "external"}, sender=${config.senderUserId ?? "external"}. ${recovering ? `Unavailable ${recovery!.unavailableRoles.join(", ")} assignment explicitly recovered; ${resetApproval ? "unsent approval reset for fresh human review" : "terms, delivery and response unchanged"}. ` : ""}${legacyAdoption ? `Legacy native offer explicitly adopted; ${resetApproval ? "unsent approval reset" : "delivered terms and response unchanged"}. ` : ""}${input.reason.trim()} No offer sent, ATS synchronization, employment confirmation or fee action.`,
      };
    },
  );
  return readOfferRouting(scope, workflowId, visible);
}
