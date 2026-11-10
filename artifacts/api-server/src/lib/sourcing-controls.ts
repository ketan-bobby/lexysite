import { and, eq, desc, sql } from "drizzle-orm";
import {
  sourcingPoliciesTable as policies,
  sourcingReservationsTable as holds,
  recruitingJourneysTable as journeys,
  sourcingCostOperationsTable as ops,
  sourcingExecutionLeasesTable as leases,
  type SourcingLimits,
} from "@workspace/db";
import {
  atomic,
  readBrief,
  fingerprint,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { allocatedCents, readCostSummary, operationWhere } from "./sourcing-cost-summary";
import { analyzeSourcingCosts } from "./sourcing-cost-analysis";
import { getInternalSourcingRuns } from "./sourcing-internal-run";
import { nativeSourcingReadiness, getNativeSourcingRuns } from "./sourcing-native-run";

type Handle = Parameters<typeof readBrief>[0];
function fail(message: string, status = 409): never {
  throw new WorkflowConflict(message, status);
}
const policyWhere = (scope: WorkflowScope) =>
  and(eq(policies.jobId, scope.jobId), eq(policies.tenantId, scope.tenantId));
const holdWhere = (scope: WorkflowScope) =>
  and(eq(holds.jobId, scope.jobId), eq(holds.tenantId, scope.tenantId));
const readPolicy = async (tx: Handle, scope: WorkflowScope) =>
  (await tx.select().from(policies).where(policyWhere(scope)))[0];
const readHolds = (tx: Handle, scope: WorkflowScope) =>
  tx.select().from(holds).where(holdWhere(scope)).orderBy(desc(holds.createdAt));

async function approvedContext(
  tx: Handle,
  scope: WorkflowScope,
  journeyId: string,
  expectedHash: string,
) {
  const current = await readBrief(tx, scope);
  if (current.hash !== expectedHash) fail("The brief changed. Refresh and renew approval.");
  if (current.job.status !== "active") fail("The requisition must be live and approved.");
  if (current.job.recruitingMode !== "lexy_autonomous")
    fail("Choose planned Lexy Autonomous mode before approving sourcing limits.");
  const [journey] = await tx
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, journeyId),
        eq(journeys.tenantId, scope.tenantId),
        eq(journeys.jobId, scope.jobId),
      ),
    );
  if (!journey || journey.status !== "approved" || journey.briefHash !== current.hash)
    fail("A current approved journey is required.");
  return current;
}

export async function getSourcingControls(tx: Handle, scope: WorkflowScope) {
  const current = await readBrief(tx, scope);
  const policy = await readPolicy(tx, scope);
  const rows = await readHolds(tx, scope);
  const allocated = await allocatedCents(tx, scope, rows);
  const cost = await readCostSummary(tx, scope);
  return {
    briefHash: current.hash,
    canEdit: true,
    canApprove: scope.canApprove,
    currency: "USD" as const,
    sourcingScope: current.job.internalMobility
      ? ("client_current_employees" as const)
      : ("known_nonemployees" as const),
    executionEnabled: false as const,
    internalDiscoveryEnabled: true,
    internalRuns: await getInternalSourcingRuns(scope),
    externalDispatch: (() => {
      const readiness = nativeSourcingReadiness(policy?.limits, current.job.internalMobility);
      return readiness;
    })(),
    externalRuns: await getNativeSourcingRuns(scope),
    outreachEnabled: false as const,
    trustedPricingAvailable: false as const,
    policy: policy ? { ...policy, stale: policy.briefHash !== current.hash } : null,
    reservations: rows.map((row) => ({
      ...row,
      stale:
        row.briefHash !== current.hash || !policy || row.policyHash !== fingerprint(policy.limits),
    })),
    allocatedCents: allocated,
    availableCents: policy ? Math.max(0, policy.limits.totalBudgetCents - allocated) : 0,
    spentMicros: cost.spentMicros,
    uncertainMicros: cost.uncertainMicros,
    pendingMicros: cost.pendingMicros,
    costOperations: cost.operations.map((o) => ({
      id: o.id,
      reservationId: o.reservationId,
      operationKey: o.operationKey,
      provider: o.provider,
      pricingVersion: o.pricingVersion,
      status: o.status,
      upperMicros: o.upperMicros,
      actualMicros: o.actualMicros,
      reportedMicros: o.reportedMicros,
      createdAt: o.createdAt,
    })),
    costAnalysis: analyzeSourcingCosts(policy?.limits ?? null),
    blockers: [
      "Allocation-hold automation is not connected to live external providers yet. Existing live external sourcing remains available separately.",
      "Provider/model costs are unverified. These holds do not establish a guaranteed USD spending cap for existing live sourcing.",
    ],
  };
}

export async function saveSourcingPolicy(
  scope: WorkflowScope,
  input: {
    idempotencyKey: string;
    expectedBriefHash: string;
    expectedRevision: number;
    limits: SourcingLimits;
  },
) {
  return atomic(scope, "sourcing.limits_saved", input, async (tx) => {
    const current = await readBrief(tx, scope);
    if (current.hash !== input.expectedBriefHash) fail("The brief changed. Refresh before saving.");
    const old = await readPolicy(tx, scope);
    if ((old?.revision ?? 0) !== input.expectedRevision)
      fail("Sourcing limits changed. Refresh before saving.");
    if (
      current.job.internalMobility &&
      (input.limits.allowExternal || input.limits.providers.length)
    )
      fail("Internal Mobility permits this client's current employees only.");
    if (input.limits.allowExternal !== input.limits.providers.length > 0)
      fail(
        "External discovery requires explicit providers; employee/known-talent-only scope must have none.",
        400,
      );
    const values = {
      jobId: scope.jobId,
      tenantId: scope.tenantId,
      revision: (old?.revision ?? 0) + 1,
      limits: input.limits,
      status: "draft" as const,
      briefHash: current.hash,
      journeyId: null,
      approvedById: null,
      approvedAt: null,
      updatedAt: new Date(),
    };
    if (old) await tx.update(policies).set(values).where(policyWhere(scope));
    else await tx.insert(policies).values(values);
    return {
      id: scope.jobId,
      note: "Planning limits saved; previous approval revoked. No execution or payment.",
    };
  });
}

export async function approveSourcingPolicy(
  scope: WorkflowScope,
  input: {
    idempotencyKey: string;
    expectedRevision: number;
    expectedBriefHash: string;
    journeyId: string;
  },
) {
  if (!scope.canApprove) fail("Human approver required", 403);
  return atomic(scope, "sourcing.limits_approved", input, async (tx) => {
    await approvedContext(tx, scope, input.journeyId, input.expectedBriefHash);
    const policy = await readPolicy(tx, scope);
    if (
      !policy ||
      policy.revision !== input.expectedRevision ||
      policy.briefHash !== input.expectedBriefHash
    )
      fail("Capture current sourcing limits before approval.");
    await tx
      .update(policies)
      .set({
        status: "approved",
        journeyId: input.journeyId,
        approvedById: scope.actorId,
        approvedAt: new Date(),
        revision: policy.revision + 1,
        updatedAt: new Date(),
      })
      .where(policyWhere(scope));
    return {
      id: scope.jobId,
      journeyId: input.journeyId,
      note: "Search scope approved. Internal testing does not require verified provider pricing.",
    };
  });
}

export async function reserveSourcingRun(
  scope: WorkflowScope,
  input: { idempotencyKey: string; expectedRevision: number; expectedBriefHash: string },
) {
  if (!scope.canApprove) fail("Human search-scope approver required", 403);
  return atomic(scope, "sourcing.budget_reserved", input, async (tx) => {
    const policy = await readPolicy(tx, scope);
    if (
      !policy ||
      policy.revision !== input.expectedRevision ||
      policy.status !== "approved" ||
      !policy.journeyId
    )
      fail("Current approved sourcing limits are required.");
    await approvedContext(tx, scope, policy.journeyId, input.expectedBriefHash);
    if (policy.briefHash !== input.expectedBriefHash) fail("Sourcing approval is stale.");
    const existing = await readHolds(tx, scope);
    if (existing.filter((r) => r.status !== "cancelled").length >= policy.limits.maxRuns)
      fail("Prepared-run limit reached. Cancel an unused hold before preparing another.");
    const [row] = await tx
      .insert(holds)
      .values({
        jobId: scope.jobId,
        tenantId: scope.tenantId,
        policyRevision: policy.revision,
        policyHash: fingerprint(policy.limits),
        briefHash: policy.briefHash,
        journeyId: policy.journeyId,
        limits: policy.limits,
        reservedCents: policy.limits.runBudgetCents,
        status: "reserved",
        createdById: scope.actorId,
      })
      .returning();
    return {
      id: row.id,
      journeyId: policy.journeyId,
      note: "Test run prepared. USD allocation is advisory, not a charge or execution cap.",
    };
  });
}

export async function controlSourcingReservation(
  scope: WorkflowScope,
  input: {
    idempotencyKey: string;
    reservationId: string;
    expectedRevision: number;
    action: "pause" | "resume" | "cancel";
  },
) {
  return atomic(scope, `sourcing.reservation_${input.action}`, input, async (tx) => {
    const [row] = await tx
      .select()
      .from(holds)
      .where(and(holdWhere(scope), eq(holds.id, input.reservationId)));
    if (!row) fail("Not found", 404);
    if (row.revision !== input.expectedRevision) fail("Reservation changed. Refresh.");
    if (row.status === "cancelled") fail("Cancelled reservations cannot be reused.");
    if (input.action === "resume") {
      const policy = await readPolicy(tx, scope);
      if (
        !policy ||
        policy.status !== "approved" ||
        policy.journeyId !== row.journeyId ||
        fingerprint(policy.limits) !== row.policyHash
      )
        fail("Renewed matching scope approval is required; old holds are never rebound.");
      await approvedContext(tx, scope, row.journeyId, row.briefHash);
      if (row.status !== "paused") fail("Only paused holds can resume.");
    }
    if (input.action === "pause" && row.status !== "reserved")
      fail("Only reserved holds can pause.");
    // Fence current workers on BOTH pause and cancel; resumed workers must
    // acquire a fresh generation. Never free a potentially dispatched cost.
    if (input.action !== "resume") {
      await tx
        .update(leases)
        .set({ leaseUntil: sql`clock_timestamp()` })
        .where(
          and(
            eq(leases.reservationId, row.id),
            eq(leases.jobId, scope.jobId),
            eq(leases.tenantId, scope.tenantId),
          ),
        );
      await tx
        .update(ops)
        .set({ status: "uncertain" })
        .where(
          and(operationWhere(scope), eq(ops.reservationId, row.id), eq(ops.status, "dispatching")),
        );
    }
    if (input.action === "cancel")
      await tx
        .update(ops)
        .set({ status: "void" })
        .where(
          and(operationWhere(scope), eq(ops.reservationId, row.id), eq(ops.status, "prepared")),
        );
    await tx
      .update(holds)
      .set({
        status:
          input.action === "cancel"
            ? "cancelled"
            : input.action === "pause"
              ? "paused"
              : "reserved",
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(holdWhere(scope), eq(holds.id, row.id)));
    return {
      id: row.id,
      journeyId: row.journeyId,
      note:
        input.action === "cancel"
          ? "Hold cancelled. Only unused allocation released; settled and uncertain costs remain counted."
          : "Prepared hold state changed. No execution.",
    };
  });
}
