import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AtsImportHistory,
  AtsImportedRecord,
  AtsRefreshInput,
} from "@workspace/api-client-react";
import { runAtsRefreshBatch, type AtsRefreshBatchItem } from "./ats-refresh-batch";

const checkedAt = "2020-04-05T06:07:08.000Z";
function record(id: string, revision = 0): AtsImportedRecord {
  return {
    id,
    refreshRevision: revision,
    lastCheckedAt: null,
    availability: "unchecked",
    importedAt: checkedAt,
    observedAt: checkedAt,
    job: { id: "101", name: "Fixture", status: "open" },
    application: {
      id: `app-${id}`,
      candidateId: `person-${id}`,
      status: "in_process",
      stageName: "Screen",
    },
  };
}
function result(r: AtsImportedRecord, unavailable = false): AtsImportHistory {
  return {
    record: {
      ...r,
      refreshRevision: r.refreshRevision + 1,
      lastCheckedAt: checkedAt,
      availability: unavailable ? "unavailable" : "available",
    },
    history: [],
    truncated: false,
  };
}
const base = () => ({
  records: [record("a"), record("b", 2), record("c", 5)],
  expectedBindingRevision: 3,
  expectedWorkflowRevision: 7,
  shouldStop: () => false,
  onProgress: (_items: AtsRefreshBatchItem[]) => {},
});

test("selected records run sequentially with exact authority, snapshot revisions and unique keys", async () => {
  const options = base();
  const calls: [string, AtsRefreshInput][] = [];
  const snapshots: AtsRefreshBatchItem[][] = [];
  let active = 0;
  let sequence = 0;
  const final = await runAtsRefreshBatch({
    ...options,
    createKey: () => `key-${++sequence}`,
    onProgress: (items) => snapshots.push(items),
    refresh: async (id, input) => {
      assert.equal(++active, 1, "no parallel provider reads");
      calls.push([id, input]);
      await Promise.resolve();
      active--;
      return result(options.records.find((r) => r.id === id)!);
    },
  });
  assert.deepEqual(
    calls.map(([id]) => id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    calls.map(([, input]) => input),
    [0, 2, 5].map((revision, i) => ({
      expectedBindingRevision: 3,
      expectedWorkflowRevision: 7,
      expectedRecordRevision: revision,
      idempotencyKey: `key-${i + 1}`,
    })),
  );
  assert.deepEqual(
    final.map((r) => r.state),
    ["available", "available", "available"],
  );
  assert.ok(final.every((r) => r.checkedAt === checkedAt));
  assert.ok(
    snapshots[0].every((r) => r.state === "queued"),
    "old progress snapshots are immutable",
  );
});

test("an unavailable record is a completed checkpoint, not a deletion or batch failure", async () => {
  const options = base();
  const final = await runAtsRefreshBatch({
    ...options,
    refresh: async (id) => result(options.records.find((r) => r.id === id)!, id === "b"),
  });
  assert.deepEqual(
    final.map((r) => r.state),
    ["available", "unavailable", "available"],
  );
  assert.match(final[1].message!, /Not proof of deletion/);
});

for (const status of [401, 403, 404, 409, 503, null]) {
  test(`failure ${status ?? "network"} stops remaining requests without retry or partial-success claims`, async () => {
    const options = base();
    const calls: string[] = [];
    const final = await runAtsRefreshBatch({
      ...options,
      refresh: async (id) => {
        calls.push(id);
        if (id === "b") throw Object.assign(new Error("PRIVATE PROVIDER PAYLOAD"), { status });
        return result(options.records.find((r) => r.id === id)!);
      },
    });
    assert.deepEqual(calls, ["a", "b"]);
    assert.deepEqual(
      final.map((r) => r.state),
      ["available", "failed", "not_started"],
    );
    assert.equal(JSON.stringify(final).includes("PRIVATE"), false);
    assert.equal(final[1].checkedAt, undefined, "failure never fabricates a checkpoint");
  });
}

test("stop during an in-flight check preserves its result and does not start the next record", async () => {
  const options = base();
  let stop = false;
  let finish!: (history: AtsImportHistory) => void;
  const calls: string[] = [];
  const pending = runAtsRefreshBatch({
    ...options,
    shouldStop: () => stop,
    refresh: async (id) => {
      calls.push(id);
      return new Promise<AtsImportHistory>((resolve) => {
        finish = resolve;
      });
    },
  });
  stop = true;
  finish(result(options.records[0]));
  const final = await pending;
  assert.deepEqual(calls, ["a"]);
  assert.deepEqual(
    final.map((r) => r.state),
    ["available", "not_started", "not_started"],
  );
});

test("already stopped/unmounted batches make no requests", async () => {
  let reads = 0;
  const final = await runAtsRefreshBatch({
    ...base(),
    shouldStop: () => true,
    refresh: async () => {
      reads++;
      throw new Error("must not run");
    },
  });
  assert.equal(reads, 0);
  assert.ok(final.every((r) => r.state === "not_started"));
});

test("invalid selection or revision is rejected before any request or progress", async () => {
  const options = base();
  for (const invalid of [
    { records: [] },
    { records: Array.from({ length: 11 }, (_, i) => record(String(i))) },
    { records: [record("a"), record("a")] },
    { records: [record("a", -1)] },
    { expectedBindingRevision: 0 },
    { expectedWorkflowRevision: -1 },
  ]) {
    let events = 0;
    await assert.rejects(
      runAtsRefreshBatch({
        ...options,
        ...invalid,
        onProgress: () => {
          events++;
        },
        refresh: async () => {
          events++;
          throw new Error("must not run");
        },
      }),
    );
    assert.equal(events, 0);
  }
});

test("changing mutable inputs mid-run cannot silently adopt newer revisions or add records", async () => {
  const options = base();
  const original = options.records.map((r) => ({ ...r }));
  const calls: [string, AtsRefreshInput][] = [];
  const runOptions = {
    ...options,
    refresh: async (id: string, input: AtsRefreshInput) => {
      calls.push([id, input]);
      runOptions.expectedBindingRevision = 99;
      runOptions.expectedWorkflowRevision = 99;
      options.records[1].refreshRevision = 999;
      options.records.push(record("foreign"));
      return result(original.find((r) => r.id === id)!);
    },
  };
  await runAtsRefreshBatch(runOptions);
  assert.deepEqual(
    calls.map(([id]) => id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    calls.map(([, r]) => r.expectedRecordRevision),
    [0, 2, 5],
  );
  assert.ok(
    calls.every(([, r]) => r.expectedBindingRevision === 3 && r.expectedWorkflowRevision === 7),
  );
});

test("a mismatched, stale or malformed success response stops the queue without claiming success", async () => {
  const options = base();
  const initial = result(options.records[0]);
  for (const changed of [
    { id: "foreign" },
    { availability: "unchecked" },
    { lastCheckedAt: null },
    { lastCheckedAt: "not a timestamp" },
    { refreshRevision: 0 },
  ]) {
    let calls = 0;
    const final = await runAtsRefreshBatch({
      ...options,
      refresh: async () => {
        calls++;
        return { ...initial, record: { ...initial.record, ...changed } } as AtsImportHistory;
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(
      final.map((r) => r.state),
      ["failed", "not_started", "not_started"],
    );
  }
});
