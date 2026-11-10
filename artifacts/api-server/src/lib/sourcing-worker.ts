/**
 * Controlled execution/recovery worker. This is NOT a live adapter registry
 * or execution grant. It proves orchestration against bounded test ports;
 * invoices are not a prerequisite for engineering this layer.
 */
import {
  acquireMeterLease,
  renewMeterLease,
  releaseMeterLease,
  prepareCostOperation,
  dispatchBoundedTestOperation,
  type BoundedTestAdapter,
  type CostRequest,
  type MeterToken,
} from "./sourcing-meter";
import { WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { snapshotWorkerPlan } from "./sourcing-worker-plan";
import { logger } from "./logger";

export async function runControlledSourcingWorker(
  scope: WorkflowScope,
  reservationId: string,
  requests: readonly CostRequest[],
  adapter: BoundedTestAdapter,
  options: { signal?: AbortSignal; heartbeatMs?: number } = {},
) {
  // No HTTP caller, feature flag, public tariff or simulated receipt can grant
  // this test port permission to make real provider calls.
  if (process.env.NODE_ENV !== "test" || adapter.mode !== "test")
    throw new WorkflowConflict("Controlled worker only; live activation is separate.");
  const interval = options.heartbeatMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 10_000)
    throw new WorkflowConflict("Invalid heartbeat interval.");
  options.signal?.throwIfAborted();
  const { plan, owner } = snapshotWorkerPlan(requests);
  return runLeasedSourcingWork(
    scope,
    reservationId,
    owner,
    async (lease, signal) => {
      // Persist every operation before the first side effect. A partial prepare
      // can be retried with the SAME plan; old bounds/attempt identities survive.
      let replayed = 0;
      for (const request of plan) {
        signal.throwIfAborted();
        const prepared = await prepareCostOperation(scope, lease, request, adapter.bound(request));
        if (prepared.operation.status === "settled") replayed++;
        else if (prepared.operation.status !== "prepared")
          throw new WorkflowConflict("Resolve the original uncertain attempt before continuing.");
      }
      for (const request of plan) {
        signal.throwIfAborted();
        const result = await dispatchBoundedTestOperation(scope, lease, request, adapter, signal);
        if (result.status !== "settled")
          throw new WorkflowConflict("Original attempt requires reconciliation; never resend.");
      }
      signal.throwIfAborted();
      await renewMeterLease(scope, lease);
      return { reservationId, status: "completed" as const, operations: plan.length, replayed };
    },
    options,
  );
}

/** Shared fencing/recovery lifecycle. The internal callback is local DB work,
 * not permission to bypass the paid dispatch gate. */
export async function runLeasedSourcingWork<T>(
  scope: WorkflowScope,
  reservationId: string,
  owner: string,
  work: (lease: MeterToken, signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    heartbeatMs?: number;
    internalOnly?: boolean;
    expectedRevision?: number;
  } = {},
) {
  const interval = options.heartbeatMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 10_000)
    throw new WorkflowConflict("Invalid heartbeat interval.");
  options.signal?.throwIfAborted();
  const lease = await acquireMeterLease(scope, reservationId, owner, options);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || signal.aborted) return;
    renewing = true;
    void renewMeterLease(scope, lease, options.internalOnly)
      .catch((error) => controller.abort(error))
      .finally(() => {
        renewing = false;
      });
  }, interval);

  try {
    return await work(lease, signal);
  } finally {
    clearInterval(heartbeat);
    controller.abort(new Error("Worker finished."));
    try {
      // Compare owner + generation; a late worker cannot release its successor.
      await releaseMeterLease(scope, lease);
    } catch {
      logger.warn("[sourcing-worker] Lease release failed; expiry still fences the worker.");
    }
  }
}
