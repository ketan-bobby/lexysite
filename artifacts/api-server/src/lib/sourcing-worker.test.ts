import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  sourcingExecutionLeasesTable as leases,
  sourcingCostOperationsTable as costs,
  sourcingPoliciesTable as policies,
} from "@workspace/db";
import type { WorkflowScope } from "./recruiting-workflows";
import {
  acquireMeterLease,
  beginCostDispatch,
  prepareCostOperation,
  releaseMeterLease,
  type CostRequest,
  type TrustedCostBound,
  type BoundedTestAdapter,
} from "./sourcing-meter";
import { snapshotWorkerPlan } from "./sourcing-worker-plan";
import { runControlledSourcingWorker } from "./sourcing-worker";

type Fixture = {
  id: string;
  scope: WorkflowScope;
};
export function registerSourcingWorkerTests(setup: () => Promise<Fixture>) {
  const request = (operationKey: string): CostRequest => ({
    operationKey,
    provider: "model",
    request: { maxTokens: 20 },
  });
  const price = (): TrustedCostBound => ({
    upperMicros: 1000,
    pricingVersion: "controlled-fixture-only",
    evidence: "Synthetic test bound; NOT an account rate",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const adapter = (invoke: BoundedTestAdapter["invoke"]): BoundedTestAdapter => ({
    mode: "test",
    bound: price,
    invoke,
  });
  const receipt = { actualMicros: 500, billingEvidence: "controlled fixture receipt only" };

  test("worker runs a durable sequence and replay never invokes settled requests twice", async () => {
    const { scope, id } = await setup();
    const calls: string[] = [];
    const port = adapter(async (input) => {
      calls.push(input.operationKey);
      return receipt;
    });
    const plan = [request("a"), request("b")];
    const first = await runControlledSourcingWorker(scope, id, plan, port);
    assert.equal(first.operations, 2);
    assert.equal(first.replayed, 0);
    const replay = await runControlledSourcingWorker(scope, id, plan, port);
    assert.equal(replay.replayed, 2);
    assert.deepEqual(calls, ["a", "b"]);
    const [lease] = await dbAdmin.select().from(leases).where(eq(leases.reservationId, id));
    assert.ok(lease.leaseUntil <= new Date());
    assert.equal(lease.generation, 2);
  });

  test("worker prepares the full plan before any call and recovers partial preparation", async () => {
    const { scope, id } = await setup();
    const plan = [request("a"), request("b")];
    let quoted = 0,
      calls = 0;
    const port = adapter(async () => {
      calls++;
      return receipt;
    });
    port.bound = () => (++quoted === 2 ? undefined : price());
    await assert.rejects(runControlledSourcingWorker(scope, id, plan, port), /pricing/);
    assert.equal(calls, 0);
    const [prepared] = await dbAdmin.select().from(costs).where(eq(costs.reservationId, id));
    assert.equal(prepared.status, "prepared");
    port.bound = price;
    await runControlledSourcingWorker(scope, id, plan, port);
    const rows = await dbAdmin.select().from(costs).where(eq(costs.reservationId, id));
    assert.ok(rows.some((r) => r.id === prepared.id && r.attemptToken === prepared.attemptToken));
    assert.equal(rows.length, 2);
    assert.equal(calls, 2);
  });

  test("worker rejects changed plan, request bodies and order after ownership is bound", async () => {
    const { scope, id } = await setup();
    const plan = [request("a"), request("b")];
    const port = adapter(async () => receipt);
    await runControlledSourcingWorker(scope, id, plan, port);
    for (const changed of [
      [request("a")],
      [...plan].reverse(),
      [request("a"), { ...request("b"), request: { maxTokens: 30 } }],
    ])
      await assert.rejects(runControlledSourcingWorker(scope, id, changed, port), /immutable/);
    await assert.rejects(acquireMeterLease(scope, id, "unbound-replacement"), /immutable/);
  });

  test("worker never retries an ambiguous dispatched request recovered from a crash", async () => {
    const { scope, id } = await setup();
    const plan = [request("crashed")];
    const { owner } = snapshotWorkerPlan(plan);
    const token = await acquireMeterLease(scope, id, owner);
    const prepared = await prepareCostOperation(scope, token, plan[0], price());
    await beginCostDispatch(scope, token, prepared.operation.id);
    await releaseMeterLease(scope, token);
    let calls = 0;
    await assert.rejects(
      runControlledSourcingWorker(
        scope,
        id,
        plan,
        adapter(async () => {
          calls++;
          return receipt;
        }),
      ),
      /uncertain/,
    );
    assert.equal(calls, 0);
    const [row] = await dbAdmin.select().from(costs).where(eq(costs.id, prepared.operation.id));
    assert.equal(row.status, "uncertain");
    assert.equal(row.attemptToken, prepared.operation.attemptToken);
  });

  test("worker heartbeats stop in-flight work after approval is revoked", async () => {
    const { scope, id } = await setup();
    let calls = 0;
    await assert.rejects(
      runControlledSourcingWorker(
        scope,
        id,
        [request("in-flight"), request("must-not-start")],
        adapter(async (_input, signal) => {
          calls++;
          await dbAdmin
            .update(policies)
            .set({ status: "draft" })
            .where(eq(policies.jobId, scope.jobId));
          await delay(2000, undefined, { signal });
          return receipt;
        }),
        { heartbeatMs: 10 },
      ),
      /aborted|stale|revoked/,
    );
    assert.equal(calls, 1);
    const rows = await dbAdmin.select().from(costs).where(eq(costs.reservationId, id));
    assert.equal(rows.find((r) => r.operationKey === "in-flight")?.status, "uncertain");
    assert.equal(rows.find((r) => r.operationKey === "must-not-start")?.status, "prepared");
  });

  test("worker cancellation stops dequeue and preserves possibly charged attempts", async () => {
    const { scope, id } = await setup();
    const stop = new AbortController();
    let calls = 0;
    await assert.rejects(
      runControlledSourcingWorker(
        scope,
        id,
        [request("a"), request("b")],
        adapter(async (_input, signal) => {
          calls++;
          stop.abort(new Error("controlled cancellation"));
          await delay(1000, undefined, { signal });
          return receipt;
        }),
        { signal: stop.signal },
      ),
      /cancellation|aborted/,
    );
    assert.equal(calls, 1);
    const rows = await dbAdmin.select().from(costs).where(eq(costs.reservationId, id));
    assert.equal(rows.find((r) => r.operationKey === "a")?.status, "uncertain");
    assert.equal(rows.find((r) => r.operationKey === "b")?.status, "prepared");
  });

  test("worker rejects duplicate operation keys and runtime activation outside test mode", async () => {
    const { scope, id } = await setup();
    const port = adapter(async () => receipt);
    await assert.rejects(
      runControlledSourcingWorker(scope, id, [request("a"), request("a")], port),
      /unique/,
    );
    const env = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      await assert.rejects(
        runControlledSourcingWorker(scope, id, [request("a")], port),
        /live activation/,
      );
    } finally {
      process.env.NODE_ENV = env;
    }
    const rows = await dbAdmin.select().from(leases).where(eq(leases.reservationId, id));
    assert.equal(rows.length, 0);
  });

  test("worker exits if a synchronous cancellation is ignored by a never-returning adapter", async () => {
    const { scope, id } = await setup();
    const stop = new AbortController();
    const promise = runControlledSourcingWorker(
      scope,
      id,
      [request("ignored")],
      adapter(async () => {
        stop.abort(new Error("synchronous cancellation"));
        return new Promise<never>(() => {});
      }),
      { signal: stop.signal },
    );
    await assert.rejects(
      Promise.race([
        promise,
        delay(2000).then(() => {
          throw new Error("missed cancellation");
        }),
      ]),
      /synchronous cancellation/,
    );
    const [row] = await dbAdmin.select().from(costs).where(eq(costs.reservationId, id));
    assert.equal(row.status, "uncertain");
  });

  test("only one worker owns a run and a stale release cannot fence its successor", async () => {
    const { scope, id } = await setup();
    const plan = [request("a")];
    const first = await acquireMeterLease(scope, id, snapshotWorkerPlan(plan).owner);
    await assert.rejects(
      runControlledSourcingWorker(
        scope,
        id,
        plan,
        adapter(async () => receipt),
      ),
      /Another worker/,
    );
    await releaseMeterLease(scope, first);
    const next = await acquireMeterLease(scope, id, snapshotWorkerPlan(plan).owner);
    assert.equal(await releaseMeterLease(scope, first), false);
    const [row] = await dbAdmin.select().from(leases).where(eq(leases.reservationId, id));
    assert.equal(row.generation, next.generation);
    assert.ok(row.leaseUntil > new Date());
  });
}
