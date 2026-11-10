import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  recruitingWorkflowEventsTable as events,
  sourcingCostOperationsTable as costs,
} from "@workspace/db";
import { z } from "zod";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { withActiveSourcingLease, type MeterToken, type CostRequest } from "./sourcing-meter";
import { NATIVE_SOURCING_ADAPTERS } from "./sourcing-providers";
import type { NativeDiscoveryResult } from "./sourcing-live-adapters";
import { NativeEnrichRequest, NativePdlRequest } from "./sourcing-native-provider-ports";
import { NativeSerpRequest } from "./sourcing-live-adapters";

const CLAIM = "sourcing.internal_request_claimed";
const OUTCOME = "sourcing.internal_request_outcome";
const Claim = z.object({
  id: z.string(),
  reservationId: z.string(),
  operationKey: z.string(),
  requestHash: z.string(),
  provider: z.enum(["serp", "pdl", "enrichlayer"]).default("serp"),
  slot: z.string().optional(),
});
const Outcome = z.object({
  id: z.string(),
  status: z.enum(["succeeded", "uncertain"]),
  costStatus: z.literal("unknown"),
});
const where = (scope: WorkflowScope, action: string) =>
  and(
    eq(events.jobId, scope.jobId),
    eq(events.tenantId, scope.tenantId),
    eq(events.action, action),
  );
const fail = (message: string): never => {
  throw new WorkflowConflict(message);
};

export async function internalSourcingAttempts(scope: WorkflowScope) {
  const claims = await dbAdmin
    .select({ note: events.note })
    .from(events)
    .where(where(scope, CLAIM));
  const outcomes = await dbAdmin
    .select({ note: events.note })
    .from(events)
    .where(where(scope, OUTCOME));
  const finished = outcomes.map((row) => Outcome.parse(JSON.parse(row.note!)));
  return claims.map((row) => {
    const claim = Claim.parse(JSON.parse(row.note!));
    return {
      ...claim,
      status: finished.find((o) => o.id === claim.id)?.status ?? "claimed",
      costStatus: "unknown" as const,
    };
  });
}

/** Internal testing deliberately has no price prerequisite or claimed USD cap.
 * A permanent scoped claim prevents replay, including after an uncertain effect.
 */
export async function dispatchInternalNativeSourcing(
  scope: WorkflowScope,
  token: MeterToken,
  input: CostRequest,
  stop: AbortSignal,
  testInvoke?: (request: CostRequest, signal: AbortSignal) => Promise<NativeDiscoveryResult>,
) {
  if (testInvoke && process.env.NODE_ENV !== "test") fail("Test transport is unavailable.");
  if (input.provider !== "serp" && input.provider !== "pdl" && input.provider !== "enrichlayer")
    fail("Provider has no native port.");
  const provider = input.provider as "serp" | "pdl" | "enrichlayer";
  const adapter = NATIVE_SOURCING_ADAPTERS[provider];
  adapter.validate(input);
  if (!adapter.isEnabled() || (!testInvoke && !adapter.isConfigured()))
    fail("Native provider or request is unavailable.");
  if (stop.aborted) fail("Execution was stopped.");
  const requestHash = fingerprint(input);
  const seed = provider === "enrichlayer" ? NativeEnrichRequest.parse(input.request).url : null;
  const slot = seed ? `enrichlayer:${fingerprint(seed)}` : provider;
  const claim = await withActiveSourcingLease(scope, token, async (tx, hold, deadline) => {
    if (!hold.limits.allowExternal || !hold.limits.providers.includes(provider))
      fail("Provider is outside the approved search scope.");
    const size =
      provider === "serp"
        ? NativeSerpRequest.parse(input.request).num
        : provider === "pdl"
          ? NativePdlRequest.parse(input.request).size
          : 1;
    if (size > hold.limits.maxCandidates) fail("Request exceeds approved candidate scope.");
    if (seed) {
      const discoveries = await tx
        .select({ note: events.note })
        .from(events)
        .where(where(scope, "sourcing.native_discovery"));
      const known = discoveries.some((row) => {
        const value = JSON.parse(row.note ?? "{}");
        return (
          value.reservationId === token.reservationId &&
          value.provider !== "enrichlayer" &&
          Array.isArray(value.profiles) &&
          value.profiles.some((p: { url?: string }) => p.url === seed)
        );
      });
      if (!known) fail("Enrichment seed is not a saved discovery from this test run.");
    }
    const previousCosts = await tx
      .select()
      .from(costs)
      .where(
        and(
          eq(costs.jobId, scope.jobId),
          eq(costs.tenantId, scope.tenantId),
          eq(costs.reservationId, token.reservationId),
        ),
      );
    if (previousCosts.some((op) => op.status !== "prepared" && op.status !== "void"))
      fail("An original request already dispatched; do not resend it.");
    const rows = await tx.select({ note: events.note }).from(events).where(where(scope, CLAIM));
    const previous = rows
      .map((row) => Claim.parse(JSON.parse(row.note!)))
      .find(
        (row) => row.reservationId === token.reservationId && (row.slot ?? row.provider) === slot,
      );
    if (previous) {
      if (previous.operationKey !== input.operationKey || previous.requestHash !== requestHash)
        fail("A claimed search cannot be changed or relabelled.");
      return { ...previous, deadline, replayed: true };
    }
    if (
      seed &&
      rows
        .map((row) => Claim.parse(JSON.parse(row.note!)))
        .filter(
          (row) => row.reservationId === token.reservationId && row.provider === "enrichlayer",
        ).length >= hold.limits.maxCandidates
    )
      fail("Enrichment exceeds approved candidate scope.");
    const value = {
      id: randomUUID(),
      reservationId: token.reservationId,
      operationKey: input.operationKey,
      requestHash,
      provider,
      slot,
    };
    await tx.insert(events).values({
      tenantId: scope.tenantId,
      jobId: scope.jobId,
      actorId: scope.actorId,
      action: CLAIM,
      note: JSON.stringify(value),
    });
    return { ...value, deadline, replayed: false };
  });
  if (claim.replayed)
    return { id: claim.id, status: "claimed" as const, costStatus: "unknown" as const };
  const controller = new AbortController();
  const abort = () => controller.abort();
  stop.addEventListener("abort", abort, { once: true });
  if (stop.aborted) abort();
  const timer = setTimeout(
    abort,
    Math.max(1, Math.min(30_000, claim.deadline.getTime() - Date.now())),
  );
  const outcome = async (status: "succeeded" | "uncertain") => {
    await dbAdmin.insert(events).values({
      tenantId: scope.tenantId,
      jobId: scope.jobId,
      actorId: scope.actorId,
      action: OUTCOME,
      note: JSON.stringify({ id: claim.id, status, costStatus: "unknown" }),
    });
  };
  try {
    if (controller.signal.aborted) fail("Execution was stopped before transport.");
    const pending = testInvoke
      ? testInvoke(input, controller.signal)
      : adapter.invoke(input, controller.signal);
    const discovery = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new WorkflowConflict("Provider outcome uncertain; no automatic retry.")),
          { once: true },
        );
      }),
    ]);
    await outcome("succeeded");
    return {
      id: claim.id,
      status: "succeeded" as const,
      costStatus: "unknown" as const,
      discovery,
    };
  } catch (error) {
    await outcome("uncertain");
    throw error;
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", abort);
  }
}
