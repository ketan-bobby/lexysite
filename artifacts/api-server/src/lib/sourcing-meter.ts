import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  usersTable,
  sourcingPoliciesTable as policies,
  sourcingReservationsTable as holds,
  sourcingExecutionLeasesTable as leases,
  sourcingCostOperationsTable as ops,
  recruitingJourneysTable as journeys,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import {
  fingerprint,
  readBrief,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { getDataScopeTenantIds, recruiterIsAssignedToJob } from "./tenantUtils";
import { committedMicros, MICROS_PER_CENT, operationWhere } from "./sourcing-cost-summary";
import { workerPlanHash, internalSourcingPlanHash } from "./sourcing-worker-plan";
import { NATIVE_SOURCING_ADAPTERS, type NativeDiscoveryResult } from "./sourcing-live-adapters";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Lease = typeof leases.$inferSelect;
export type MeterToken = Pick<Lease, "reservationId" | "owner" | "generation">;
export type CostRequest = {
  operationKey: string;
  provider: "github" | "pdl" | "serp" | "enrichlayer" | "model";
  // Every SDK/HTTP request, fan-out child and retry is a separate operation.
  request: unknown;
  candidateId?: string;
};
export type TrustedCostBound = {
  upperMicros: number;
  pricingVersion: string;
  evidence: string;
  expiresAt: Date;
};
// Internal testing is not gated by vendor pricing. Verified-dollar metering
// remains a separate facility; it is not an activation or feature permission.
export const REAL_SOURCING_DISPATCH_ENABLED = true;
export const livePricingCatalog: ReadonlyMap<string, TrustedCostBound> = new Map();
function fail(message: string): never {
  throw new WorkflowConflict(message);
}
const scoped = (s: WorkflowScope) => and(eq(holds.jobId, s.jobId), eq(holds.tenantId, s.tenantId));
const leaseWhere = (s: WorkflowScope, id: string) =>
  and(eq(leases.reservationId, id), eq(leases.jobId, s.jobId), eq(leases.tenantId, s.tenantId));
const micros = (n: number, positive = false) => {
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0) || n > 100_000_000_000)
    fail("Invalid integer USD micro-unit amount.");
};
async function locked<T>(scope: WorkflowScope, fn: (tx: Tx, now: Date) => Promise<T>) {
  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recruiting-workflow:${scope.jobId}`},0))`,
    );
    const [job] = await tx
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)))
      .for("update");
    if (!job) fail("Not found");
    const time = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const stamp = time.rows[0].now;
    return fn(tx, stamp instanceof Date ? stamp : new Date(String(stamp)));
  });
}
async function authority(
  tx: Tx,
  scope: WorkflowScope,
  userId = scope.actorId,
  internalOnly = false,
) {
  const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, userId));
  if (
    !user ||
    user.status !== "active" ||
    ![
      "platform_admin",
      "tenant_admin",
      "recruiter_admin",
      "hiring_manager",
      ...(internalOnly ? ["recruiter"] : []),
    ].includes(user.role)
  )
    fail("Current human execution authority is required.");
  const allowed = await getDataScopeTenantIds(user);
  const [job] = await tx
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)));
  if (
    !job ||
    (allowed !== null && !allowed.includes(scope.tenantId)) ||
    (user.role === "hiring_manager" && job.assignedHiringManagerId !== user.id) ||
    (user.role === "recruiter" && !(await recruiterIsAssignedToJob(user.id, job)))
  )
    fail("Current requisition authority is required.");
}
async function context(tx: Tx, scope: WorkflowScope, id: string, internalOnly = false) {
  await authority(tx, scope, scope.actorId, internalOnly);
  const [hold] = await tx
    .select()
    .from(holds)
    .where(and(scoped(scope), eq(holds.id, id)));
  if (!hold || hold.status !== "reserved") fail("A reserved, unpaused hold is required.");
  const [policy] = await tx
    .select()
    .from(policies)
    .where(and(eq(policies.jobId, scope.jobId), eq(policies.tenantId, scope.tenantId)));
  const current = await readBrief(tx, scope);
  const [journey] = await tx
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, hold.journeyId),
        eq(journeys.jobId, scope.jobId),
        eq(journeys.tenantId, scope.tenantId),
      ),
    );
  if (
    !policy ||
    policy.status !== "approved" ||
    policy.revision !== hold.policyRevision ||
    policy.journeyId !== hold.journeyId ||
    policy.briefHash !== hold.briefHash ||
    fingerprint(policy.limits) !== hold.policyHash ||
    hold.briefHash !== current.hash ||
    current.job.status !== "active" ||
    current.job.recruitingMode !== "lexy_autonomous" ||
    !journey ||
    journey.status !== "approved" ||
    journey.briefHash !== current.hash ||
    !policy.approvedById
  )
    fail("Approved execution snapshot is stale or revoked.");
  await authority(tx, scope, policy.approvedById);
  // Internal testing is authorized by the approved search scope, not by a USD
  // planning allocation. Verified per-operation pricing, when explicitly used,
  // remains a separate facility; unpriced requests never invent a dollar cap.
  return hold;
}
async function activeLease(
  tx: Tx,
  scope: WorkflowScope,
  token: MeterToken,
  now: Date,
  internalOnly = false,
) {
  const hold = await context(tx, scope, token.reservationId, internalOnly);
  const [lease] = await tx.select().from(leases).where(leaseWhere(scope, token.reservationId));
  if (
    !lease ||
    lease.owner !== token.owner ||
    lease.generation !== token.generation ||
    lease.actorId !== scope.actorId ||
    lease.leaseUntil <= now ||
    lease.deadline <= now
  )
    fail("Lease expired, fenced, or runtime limit reached.");
  return { hold, lease };
}
export async function acquireMeterLease(
  scope: WorkflowScope,
  id: string,
  owner: string,
  options: { internalOnly?: boolean; expectedRevision?: number } = {},
) {
  if (!owner || owner.length > 128) fail("Worker identity is required.");
  return locked(scope, async (tx, now) => {
    const hold = await context(tx, scope, id, options.internalOnly);
    if (options.expectedRevision !== undefined && hold.revision !== options.expectedRevision)
      fail("Reservation changed. Refresh.");
    if (options.internalOnly) {
      if (workerPlanHash(owner) !== internalSourcingPlanHash(hold))
        fail("A bound local-only plan is required.");
      const existing = await tx
        .select({ id: ops.id })
        .from(ops)
        .where(and(operationWhere(scope), eq(ops.reservationId, id)))
        .limit(1);
      if (existing.length)
        fail("An external-operation hold cannot be used for internal discovery.");
    }
    const [old] = await tx.select().from(leases).where(leaseWhere(scope, id));
    const oldPlan = old ? workerPlanHash(old.owner) : null;
    const nextPlan = workerPlanHash(owner);
    if (oldPlan && oldPlan !== nextPlan)
      fail("A recovered worker must use the original immutable execution plan.");
    if (old && old.leaseUntil > now) fail("Another worker owns the active lease.");
    if (old && old.deadline <= now) fail("Runtime limit reached; the deadline never resets.");
    // A crash after a dispatch marker is ambiguous, not permission to resend.
    await tx
      .update(ops)
      .set({ status: "uncertain" })
      .where(and(operationWhere(scope), eq(ops.reservationId, id), eq(ops.status, "dispatching")));
    const values = {
      reservationId: id,
      jobId: scope.jobId,
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      owner,
      generation: (old?.generation ?? 0) + 1,
      leaseUntil: new Date(Math.min(now.getTime() + 30_000, old?.deadline.getTime() ?? Infinity)),
      startedAt: old?.startedAt ?? now,
      deadline: old?.deadline ?? new Date(now.getTime() + hold.limits.maxDurationSeconds * 1000),
      candidateIds: old?.candidateIds ?? [],
    };
    if (old) await tx.update(leases).set(values).where(leaseWhere(scope, id));
    else await tx.insert(leases).values(values);
    // Safe recovery of NEVER-dispatched work keeps the same durable identity
    // and cost bound. Dispatched/uncertain attempts are never adopted.
    await tx
      .update(ops)
      .set({ generation: values.generation })
      .where(and(operationWhere(scope), eq(ops.reservationId, id), eq(ops.status, "prepared")));
    return values;
  });
}
export async function renewMeterLease(
  scope: WorkflowScope,
  token: MeterToken,
  internalOnly = false,
) {
  return locked(scope, async (tx, now) => {
    const { lease } = await activeLease(tx, scope, token, now, internalOnly);
    const leaseUntil = new Date(Math.min(now.getTime() + 30_000, lease.deadline.getTime()));
    await tx.update(leases).set({ leaseUntil }).where(leaseWhere(scope, token.reservationId));
    return { ...lease, leaseUntil };
  });
}
// Local-only completion is one transaction with the active approval/fence
// check. Candidate IDs (including an empty shortlist) and its completion event
// survive process death; there is no synthetic cost receipt.
export async function checkpointInternalSourcing(
  scope: WorkflowScope,
  token: MeterToken,
  candidateIds: string[],
) {
  return locked(scope, async (tx, now) => {
    const { hold } = await activeLease(tx, scope, token, now, true);
    if (workerPlanHash(token.owner) !== internalSourcingPlanHash(hold))
      fail("A bound local-only plan is required.");
    if (
      new Set(candidateIds).size !== candidateIds.length ||
      candidateIds.length > hold.limits.maxCandidates
    )
      fail("Internal shortlist exceeds the approved candidate limit.");
    const [completed] = await tx
      .select()
      .from(events)
      .where(
        and(
          eq(events.jobId, scope.jobId),
          eq(events.tenantId, scope.tenantId),
          eq(events.action, "sourcing.internal_completed"),
          eq(events.note, token.reservationId),
        ),
      );
    if (completed) return;
    await tx.update(leases).set({ candidateIds }).where(leaseWhere(scope, token.reservationId));
    await tx.insert(events).values({
      jobId: scope.jobId,
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      journeyId: hold.journeyId,
      action: "sourcing.internal_completed",
      note: token.reservationId,
    });
  });
}
export async function releaseMeterLease(scope: WorkflowScope, token: MeterToken) {
  return locked(scope, async (tx, now) => {
    const rows = await tx
      .update(leases)
      .set({ leaseUntil: now })
      .where(
        and(
          leaseWhere(scope, token.reservationId),
          eq(leases.owner, token.owner),
          eq(leases.generation, token.generation),
          eq(leases.actorId, scope.actorId),
        ),
      )
      .returning({ id: leases.reservationId });
    return rows.length === 1;
  });
}
export async function prepareCostOperation(
  scope: WorkflowScope,
  token: MeterToken,
  input: CostRequest,
  bound: TrustedCostBound | undefined,
) {
  return locked(scope, async (tx, now) => {
    const { hold, lease } = await activeLease(tx, scope, token, now);
    if (
      !bound ||
      !bound.pricingVersion ||
      !bound.evidence ||
      !Number.isFinite(bound.expiresAt.getTime()) ||
      bound.expiresAt <= now
    )
      fail("Verified, current upper-bound pricing is required.");
    micros(bound.upperMicros, true);
    if (!input.operationKey || input.operationKey.length > 128)
      fail("Stable operation identity required.");
    if (
      input.provider !== "model" &&
      (!hold.limits.allowExternal || !hold.limits.providers.includes(input.provider))
    )
      fail("Provider is outside approved scope.");
    const hash = fingerprint({
      provider: input.provider,
      request: input.request,
      candidateId: input.candidateId,
    });
    const existing = await tx
      .select()
      .from(ops)
      .where(and(operationWhere(scope), eq(ops.reservationId, hold.id)));
    const previous = existing.find((o) => o.operationKey === input.operationKey);
    if (previous) {
      if (previous.requestHash !== hash) fail("Operation identity reused for a different request.");
      // Recovery preserves the original identity and immutable price bound.
      return { operation: previous, replayed: true };
    }
    const jobOperations = await tx.select().from(ops).where(operationWhere(scope));
    if (jobOperations.some((o) => o.status === "uncertain" || o.status === "dispatching"))
      fail("Resolve uncertain/in-flight costs before another operation.");
    if (input.candidateId && !lease.candidateIds.includes(input.candidateId)) {
      if (lease.candidateIds.length >= hold.limits.maxCandidates)
        fail("Candidate stopping limit reached.");
      await tx
        .update(leases)
        .set({ candidateIds: [...lease.candidateIds, input.candidateId] })
        .where(leaseWhere(scope, hold.id));
    }
    if (
      existing.reduce((n, o) => n + committedMicros(o), 0) + bound.upperMicros >
      hold.reservedCents * MICROS_PER_CENT
    )
      fail("Per-run USD cost cap reached.");
    const [operation] = await tx
      .insert(ops)
      .values({
        reservationId: hold.id,
        jobId: scope.jobId,
        tenantId: scope.tenantId,
        operationKey: input.operationKey,
        requestHash: hash,
        provider: input.provider,
        pricingVersion: bound.pricingVersion,
        quoteExpiresAt: bound.expiresAt,
        evidence: bound.evidence,
        upperMicros: bound.upperMicros,
        status: "prepared",
        generation: token.generation,
        attemptToken: randomUUID(),
      })
      .returning();
    return { operation, replayed: false };
  });
}
export async function beginCostDispatch(scope: WorkflowScope, token: MeterToken, id: string) {
  return locked(scope, async (tx, now) => {
    await activeLease(tx, scope, token, now);
    const [op] = await tx
      .select()
      .from(ops)
      .where(
        and(operationWhere(scope), eq(ops.id, id), eq(ops.reservationId, token.reservationId)),
      );
    if (!op || op.status !== "prepared" || op.generation !== token.generation)
      fail("Operation already dispatched, ambiguous, cancelled or fenced; never resend.");
    if (op.quoteExpiresAt <= now) fail("Pricing expired before dispatch; do not send.");
    const outstanding = await tx.select().from(ops).where(operationWhere(scope));
    if (outstanding.some((o) => o.status === "uncertain" || o.status === "dispatching"))
      fail("Resolve uncertain/in-flight costs before dispatch.");
    await tx
      .update(ops)
      .set({ status: "dispatching", dispatchedAt: now })
      .where(and(operationWhere(scope), eq(ops.id, id)));
    return { ...op, status: "dispatching" as const, dispatchedAt: now };
  });
}
export async function markCostUncertain(scope: WorkflowScope, id: string, attemptToken: string) {
  return locked(scope, async (tx) => {
    await tx
      .update(ops)
      .set({ status: "uncertain" })
      .where(
        and(
          operationWhere(scope),
          eq(ops.id, id),
          eq(ops.attemptToken, attemptToken),
          eq(ops.status, "dispatching"),
        ),
      );
  });
}
export async function settleCostOperation(
  scope: WorkflowScope,
  id: string,
  attemptToken: string,
  actualMicros: number,
  billingEvidence: string,
) {
  micros(actualMicros);
  if (!billingEvidence.trim() || billingEvidence.length > 1000)
    fail("Billing evidence is required.");
  return locked(scope, async (tx, now) => {
    const [op] = await tx
      .select()
      .from(ops)
      .where(and(operationWhere(scope), eq(ops.id, id), eq(ops.attemptToken, attemptToken)));
    if (!op || !["dispatching", "uncertain", "settled"].includes(op.status))
      fail("A matching dispatched attempt is required.");
    if (op.status === "settled") {
      if (op.actualMicros !== actualMicros || op.billingEvidence !== billingEvidence)
        fail("Conflicting settlement evidence.");
      return op;
    }
    // Late responses can settle their ORIGINAL attempt after cancellation or
    // lease expiry; they cannot launch any further work.
    if (actualMicros > op.upperMicros) {
      const [row] = await tx
        .update(ops)
        .set({ status: "uncertain", reportedMicros: actualMicros, billingEvidence })
        .where(and(operationWhere(scope), eq(ops.id, id)))
        .returning();
      return row; // Persist the anomaly rather than rolling it back in an exception.
    }
    const [row] = await tx
      .update(ops)
      .set({
        status: "settled",
        actualMicros,
        billingEvidence,
        settledAt: now,
      })
      .where(and(operationWhere(scope), eq(ops.id, id)))
      .returning();
    return row;
  });
}
export type BoundedTestAdapter = {
  mode: "test";
  bound(input: CostRequest): TrustedCostBound | undefined;
  // Exactly ONE bounded operation; no internal fan-out or retries.
  invoke(
    input: CostRequest,
    signal: AbortSignal,
  ): Promise<{ actualMicros: number; billingEvidence: string }>;
};
export async function dispatchBoundedTestOperation(
  scope: WorkflowScope,
  token: MeterToken,
  input: CostRequest,
  adapter: BoundedTestAdapter,
  stopSignal?: AbortSignal,
) {
  if (process.env.NODE_ENV !== "test" || adapter.mode !== "test")
    fail("Test adapter execution only. Real autonomous dispatch remains locked.");
  return dispatchBoundedOperation(scope, token, input, adapter, stopSignal);
}

/** The only native paid port currently audited is one SerpAPI discovery request.
 * Quotes come from the server catalog, never from an HTTP body or planning rates.
 * SerpAPI does not return attributable USD charges: retain the whole bound as
 * uncertain until billing evidence reconciles the original attempt.
 */
export async function dispatchNativeSourcingOperation(
  scope: WorkflowScope,
  token: MeterToken,
  input: CostRequest,
  stopSignal: AbortSignal,
  testInvoke?: (input: CostRequest, signal: AbortSignal) => Promise<NativeDiscoveryResult>,
) {
  if (testInvoke && process.env.NODE_ENV !== "test") fail("Test transport is not permitted.");
  const adapter = NATIVE_SOURCING_ADAPTERS.serp;
  adapter.validate(input);
  if (!adapter.isEnabled() || (!testInvoke && !adapter.isConfigured()))
    fail("Native SerpAPI discovery is unavailable.");
  let discovery: NativeDiscoveryResult | undefined;
  const operation = await dispatchBoundedOperation(
    scope,
    token,
    input,
    {
      bound: adapter.bound,
      invoke: async (request, signal) => {
        discovery = testInvoke
          ? await testInvoke(request, signal)
          : await adapter.invoke(request, signal);
        return {};
      },
    },
    stopSignal,
  );
  return { ...operation, discovery };
}

async function dispatchBoundedOperation(
  scope: WorkflowScope,
  token: MeterToken,
  input: CostRequest,
  adapter: {
    bound(input: CostRequest): TrustedCostBound | undefined;
    invoke(
      input: CostRequest,
      signal: AbortSignal,
    ): Promise<{
      actualMicros?: number;
      billingEvidence?: string;
    }>;
  },
  stopSignal?: AbortSignal,
) {
  stopSignal?.throwIfAborted();
  const prepared = await prepareCostOperation(scope, token, input, adapter.bound(input));
  if (prepared.replayed && prepared.operation.status !== "prepared") return prepared.operation;
  const operation = await beginCostDispatch(scope, token, prepared.operation.id);
  try {
    const timer = await locked(scope, async (tx, now) => {
      const { lease } = await activeLease(tx, scope, token, now);
      return Math.max(
        1,
        Math.min(lease.leaseUntil.getTime(), lease.deadline.getTime()) - now.getTime(),
      );
    });
    const timeout = AbortSignal.timeout(timer);
    const signal = stopSignal ? AbortSignal.any([timeout, stopSignal]) : timeout;
    signal.throwIfAborted();
    const response = adapter.invoke(input, signal).then(async (result) => {
      if (result.actualMicros === undefined || !result.billingEvidence) {
        await markCostUncertain(scope, operation.id, operation.attemptToken);
        return { ...operation, status: "uncertain" as const };
      }
      return settleCostOperation(
        scope,
        operation.id,
        operation.attemptToken,
        result.actualMicros,
        result.billingEvidence,
      );
    });
    // Register/check abortion even if invoke() synchronously stopped the worker
    // and then ignored the signal. Never wait for a missed abort event.
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          stopSignal?.aborted
            ? stopSignal.reason
            : new Error("Operation interrupted; cost remains uncertain."),
        );
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // Late receipts still settle only their original immutable attempt.
      return await Promise.race([response, interrupted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    await markCostUncertain(scope, operation.id, operation.attemptToken);
    throw error;
  }
}
export function assertRealSourcingDispatchAllowed(): void {
  // Compatibility only. Authorization, consent and execution claims own access.
}

export async function withActiveSourcingLease<T>(
  scope: WorkflowScope,
  token: MeterToken,
  fn: (tx: Tx, hold: Awaited<ReturnType<typeof context>>, deadline: Date) => Promise<T>,
) {
  return locked(scope, async (tx, now) => {
    const { hold, lease } = await activeLease(tx, scope, token, now);
    return fn(tx, hold, lease.deadline);
  });
}
