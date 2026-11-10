import { test } from "node:test";
import assert from "node:assert/strict";
import { dbAdmin, agentRunsTable, agentRunEventsTable } from "@workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { reconcileStaleAgentRuns } from "./recorder";
import { reconcileStalePipelineRuns } from "../pipeline-runs/reconcile";
import { logger } from "../logger";

test("recovery uses the real SQL status/cutoff predicate; fresh and terminal runs stay untouched", async (t) => {
  const cutoff = new Date("2026-01-01T12:00:00Z");
  const rows = [
    {
      id: "old-running",
      tenantId: "fixture-a",
      status: "running",
      createdAt: new Date(+cutoff - 1000),
    },
    {
      id: "old-queued",
      tenantId: "fixture-b",
      status: "queued",
      createdAt: new Date(+cutoff - 1000),
    },
    {
      id: "completed",
      tenantId: "fixture-a",
      status: "completed",
      createdAt: new Date(+cutoff - 1000),
    },
    {
      id: "cancelled",
      tenantId: "fixture-b",
      status: "cancelled",
      createdAt: new Date(+cutoff - 1000),
    },
    { id: "failed", tenantId: "fixture-a", status: "failed", createdAt: new Date(+cutoff - 1000) },
    {
      id: "fresh-during-boot",
      tenantId: "fixture-a",
      status: "running",
      createdAt: new Date(+cutoff + 1),
    },
    { id: "exact-boundary", tenantId: "fixture-b", status: "queued", createdAt: cutoff },
  ];
  const events: any[] = [];
  const errors: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => {
    errors.push(args);
  });
  // No global recovery UPDATE is sent to the shared database. Compile its real
  // Drizzle WHERE clause and execute only against these in-memory fixtures.
  t.mock.method(dbAdmin, "update", (table: unknown) => {
    assert.equal(table, agentRunsTable);
    return {
      set: (values: any) => ({
        where: (predicate: any) => {
          const query = new PgDialect().sqlToQuery(predicate);
          // emitRunEvent also touches the recovered run's updated_at marker.
          // Exercise that ordinary by-id write without sending it to PostgreSQL.
          if (query.sql === '"agent_runs"."id" = $1') {
            const row = rows.find((item) => item.id === query.params[0]);
            assert.ok(row, "Event marker must only touch a recovered fixture");
            Object.assign(row, values);
            return Promise.resolve();
          }
          assert.match(query.sql, /"agent_runs"\."status" in /);
          assert.match(query.sql, /and "agent_runs"\."created_at" < /);
          assert.deepEqual(query.params.slice(0, 2), ["queued", "running"]);
          assert.equal(new Date(query.params[2] as string).getTime(), +cutoff);
          return {
            returning: async () =>
              rows
                .filter(
                  (row) =>
                    query.params.slice(0, 2).includes(row.status) && +row.createdAt < +cutoff,
                )
                .map((row) => {
                  Object.assign(row, values);
                  return { id: row.id, tenantId: row.tenantId };
                }),
          };
        },
      }),
    };
  });
  t.mock.method(dbAdmin, "insert", (table: unknown) => {
    assert.equal(table, agentRunEventsTable);
    return {
      values: async (event: any) => {
        events.push(event);
      },
    };
  });
  await reconcileStaleAgentRuns(cutoff);
  assert.deepEqual(
    rows.map((row) => row.status),
    ["failed", "failed", "completed", "cancelled", "failed", "running", "queued"],
  );
  assert.deepEqual(
    events.map((event) => [event.runId, event.tenantId, event.type]),
    [
      ["old-running", "fixture-a", "run_failed"],
      ["old-queued", "fixture-b", "run_failed"],
    ],
  );
  // Second recovery is idempotent. A new run after recovery is also protected.
  rows.push({
    id: "fresh-after",
    tenantId: "fixture-b",
    status: "running",
    createdAt: new Date(+cutoff + 2000),
  });
  await reconcileStaleAgentRuns(cutoff);
  assert.equal(events.length, 2);
  assert.equal(rows.at(-1)?.status, "running");
  assert.equal(errors.length, 0, "Successful fixture recovery must not swallow mock/SQL errors");
});

test("database recovery failures propagate in startup mode, without dispatch or notifications", async (t) => {
  const error = new Error("fixture database failure");
  t.mock.method(dbAdmin, "update", () => {
    throw error;
  });
  await assert.rejects(reconcileStaleAgentRuns(new Date()), (caught) => caught === error);
  await assert.rejects(reconcileStalePipelineRuns({ strict: true }), (caught) => caught === error);
  // Preserve the previous best-effort API for non-startup pipeline callers.
  assert.equal(await reconcileStalePipelineRuns(), 0);
});

test("invalid recovery cutoff is rejected before any database write", async (t) => {
  let writes = 0;
  t.mock.method(dbAdmin, "update", () => {
    writes++;
  });
  await assert.rejects(reconcileStaleAgentRuns(new Date(NaN)), /valid startup cutoff/);
  assert.equal(writes, 0);
});
