/**
 * audit.test.ts — unit tests for the immutable audit log writer.
 *
 * The drizzle admin handle's `insert` is stubbed in-memory — no real DB.
 * Run: npx tsx --test src/lib/audit.test.ts
 */
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const { dbAdmin } = await import("@workspace/db");
const { recordAudit } = await import("./audit");

let insertedRows: any[] = [];
let insertShouldThrow = false;

beforeEach(() => {
  mock.restoreAll();
  insertedRows = [];
  insertShouldThrow = false;
  mock.method(dbAdmin as any, "insert", () => ({
    values: async (row: any) => {
      if (insertShouldThrow) throw new Error("connection refused");
      insertedRows.push(row);
    },
  }));
});

const minimalInput = {
  actorType: "system" as const,
  channel: "system" as const,
  direction: "internal" as const,
  action: "test.event",
};

test("writes a row with all optional fields defaulted to null", async () => {
  await recordAudit(minimalInput);
  assert.equal(insertedRows.length, 1);
  const row = insertedRows[0];
  assert.equal(row.action, "test.event");
  assert.equal(row.tenantId, null);
  assert.equal(row.actorId, null);
  assert.equal(row.subjectType, null);
  assert.equal(row.body, null);
  assert.equal(row.metadata, null);
});

test("passes through fully-populated input", async () => {
  await recordAudit({
    tenantId: "ten-1",
    actorType: "agent",
    actorId: "agent-7",
    actorLabel: "Outreach Engine",
    subjectType: "candidate",
    subjectId: "cand-1",
    subjectLabel: "Jane Doe",
    channel: "email",
    direction: "outbound",
    action: "outreach.send",
    title: "First touch",
    body: "Hello Jane",
    metadata: { jobId: "job-1" },
  });
  const row = insertedRows[0];
  assert.equal(row.tenantId, "ten-1");
  assert.equal(row.actorLabel, "Outreach Engine");
  assert.equal(row.subjectId, "cand-1");
  assert.equal(row.body, "Hello Jane");
  assert.deepEqual(row.metadata, { jobId: "job-1" });
});

test("truncates body to 8000 characters", async () => {
  await recordAudit({ ...minimalInput, body: "x".repeat(20_000) });
  assert.equal(insertedRows[0].body.length, 8000);
});

test("empty-string body is stored as null (falsy guard)", async () => {
  await recordAudit({ ...minimalInput, body: "" });
  assert.equal(insertedRows[0].body, null);
});

test("NEVER throws when the insert fails", async () => {
  insertShouldThrow = true;
  await assert.doesNotReject(recordAudit(minimalInput));
  assert.equal(insertedRows.length, 0);
});
