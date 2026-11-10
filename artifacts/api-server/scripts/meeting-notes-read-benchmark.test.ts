import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { benchmarkScopedReads } from "./meeting-notes-read-benchmark";

test("runs every verified read with bounded concurrent admission and numeric percentiles", async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const result = await benchmarkScopedReads({
    scenario: "owned-note",
    samples: 12,
    concurrency: 4,
    readAndVerify: async (signal) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await setTimeout(5, undefined, { signal });
      active--;
    },
  });
  assert.equal(calls, 12);
  assert.equal(result.samples, 12);
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.ok(result.maxMs >= result.p95Ms && result.p95Ms >= result.p50Ms);
  assert.equal(result.scope, "isolated-development-fixture");
  assert.ok(Number.isFinite(result.sampledRssIncreaseBytes));
});

test("fails closed without logging the response and settles active work before throwing", async () => {
  let active = 0;
  let started = 0;
  await assert.rejects(
    benchmarkScopedReads({
      scenario: "foreign-scope",
      samples: 20,
      concurrency: 4,
      readAndVerify: async () => {
        const index = started++;
        active++;
        try {
          await setTimeout(index === 0 ? 5 : 20);
          if (index === 0) throw new Error("private response must not be copied");
        } finally {
          active--;
        }
      },
    }),
    { message: "foreign-scope: 1 read verification(s) failed; no success report" },
  );
  assert.equal(active, 0);
  assert.equal(started, 4);
});

test("rejects a read that outlives its abort deadline", async () => {
  await assert.rejects(
    benchmarkScopedReads({
      scenario: "timed-out",
      samples: 1,
      concurrency: 1,
      timeoutMs: 10,
      readAndVerify: async (signal) => {
        await setTimeout(30);
        assert.equal(signal.aborted, true);
      },
    }),
    /no success report/,
  );
});

test("refuses unsafe sizes, concurrency, labels and deadlines before calling reads", async () => {
  let calls = 0;
  const options = {
    scenario: "owned-note",
    samples: 2,
    concurrency: 1,
    readAndVerify: async () => {
      calls++;
    },
  };
  for (const change of [
    { samples: 0 },
    { samples: 501 },
    { concurrency: 0 },
    { concurrency: 9 },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { scenario: "unsafe label\n" },
    { scenario: "owned-note\n" },
  ]) {
    await assert.rejects(benchmarkScopedReads({ ...options, ...change }), /Invalid bounded/);
  }
  assert.equal(calls, 0);
});
