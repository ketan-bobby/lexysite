/**
 * read.test.ts — Persisted-first Agent Hub reads (Part 3)
 *
 * Two layers:
 *   1. Pure merge policy (mergeRuns / mergeActivity) — persisted is the source of
 *      truth; the in-memory cache only adds strictly-newer entries (in-flight
 *      freshness) or fills in entirely when persisted is empty.
 *   2. Integration (emit → view read) — emitPipelineRunEvent persists to
 *      pipeline_run_events and getPersistedActivity reads them back through the
 *      sanctioned run_activity_events union view, tenant-scoped by `allowed`.
 *
 * Rows are seeded straight onto pipeline_runs + pipeline_run_events via dbAdmin
 * (BYPASSRLS). pipeline_runs has no FK to tenants/jobs so plain-text ids are fine;
 * pipeline_run_events.run_id DOES FK → pipeline_runs(id), so the parent run is
 * seeded first. All ids are prefixed `rpre_`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { dbAdmin, pipelineRunsTable, pipelineRunEventsTable } from "@workspace/db";
import type { AgentRun, AgentEvent } from "../agents/orchestrator";
import { mergeRuns, mergeActivity, getPersistedActivity } from "./read";
import { emitPipelineRunEvent } from "./recorder";

const P = "rpre_";
const id = (s: string) => P + s;
const TENANT = id("tenant");
const OTHER_TENANT = id("other_tenant");
const RUN = id("run");
const OTHER_RUN = id("other_run");
const CONC_RUN = id("conc_run");
const RUN_IDS = [RUN, OTHER_RUN, CONC_RUN];

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function run(over: Partial<AgentRun>): AgentRun {
  return {
    id: crypto.randomUUID(),
    agentId: "sourcing" as any,
    triggeredBy: "system",
    tenantId: TENANT,
    jobId: id("job"),
    input: {},
    status: "completed",
    startedAt: iso(0),
    ...over,
  };
}

// ── Pure merge policy ────────────────────────────────────────────────────────

test("mergeRuns: empty persisted falls back entirely to the cache", () => {
  const cache = [run({ startedAt: iso(1000) }), run({ startedAt: iso(2000) })];
  assert.deepEqual(mergeRuns([], cache, 10), cache.slice(0, 10));
});

test("mergeRuns: persisted wins; cache adds only strictly-newer entries", () => {
  const persisted = [run({ jobId: "j1", agentId: "icp" as any, startedAt: iso(5000) })];
  const newer = run({ jobId: "j2", agentId: "sourcing" as any, startedAt: iso(1000) });
  const older = run({ jobId: "j3", agentId: "screening" as any, startedAt: iso(9000) });
  const merged = mergeRuns(persisted, [newer, older], 10);
  assert.ok(merged.includes(newer), "strictly-newer cache entry is included for freshness");
  assert.ok(!merged.includes(older), "older cache entry is dropped (persisted is source of truth)");
  assert.ok(merged.includes(persisted[0]));
});

test("mergeRuns: a cache entry duplicating a persisted (jobId+agentId) is dropped", () => {
  const persisted = [run({ jobId: "dup", agentId: "icp" as any, startedAt: iso(5000) })];
  const dupeNewer = run({ jobId: "dup", agentId: "icp" as any, startedAt: iso(100) });
  const merged = mergeRuns(persisted, [dupeNewer], 10);
  assert.ok(!merged.includes(dupeNewer), "same jobId+agentId as a persisted run is a transient dupe");
  assert.equal(merged.length, 1);
});

test("mergeRuns: result is capped at limit", () => {
  const persisted = Array.from({ length: 5 }, (_, i) => run({ startedAt: iso(1000 + i) }));
  assert.equal(mergeRuns(persisted, [], 3).length, 3);
});

test("mergeRuns: a genuinely NEW re-run of the same job+agent is kept (not a twin)", () => {
  // persisted run for jX/icp finished 10 min ago; a fresh re-run starts now.
  const persisted = [run({ jobId: "jX", agentId: "icp" as any, startedAt: iso(10 * 60_000) })];
  const rerun = run({ jobId: "jX", agentId: "icp" as any, startedAt: iso(0) });
  const merged = mergeRuns(persisted, [rerun], 10);
  assert.ok(merged.includes(rerun), "a re-run far outside the twin window must not be suppressed");
});

test("mergeActivity: empty persisted maps the cache; non-empty adds only newer", () => {
  const ev = (over: Partial<AgentEvent>): AgentEvent => ({
    id: crypto.randomUUID(), type: "run_started", agentId: "sourcing" as any,
    tenantId: TENANT, payload: {}, timestamp: iso(0), processed: false, ...over,
  });
  const cacheOnly = mergeActivity([], [ev({ timestamp: iso(500) })], 10);
  assert.equal(cacheOnly.length, 1);
  assert.equal(cacheOnly[0].runType, "memory");

  const persisted = [{
    id: "p1", runId: RUN, runType: "pipeline", type: "run_started", stepName: null,
    message: "x", payload: null, timestamp: iso(3000), tenantId: TENANT,
  }];
  const merged = mergeActivity(persisted, [ev({ timestamp: iso(1000) }), ev({ timestamp: iso(9000) })], 10);
  assert.ok(merged.some(e => e.timestamp === iso(1000)), "newer cache event kept");
  assert.ok(!merged.some(e => e.timestamp === iso(9000)), "older cache event dropped");
});

// ── Integration: emit → union view read ──────────────────────────────────────

async function cleanup() {
  await dbAdmin.delete(pipelineRunEventsTable).where(inArray(pipelineRunEventsTable.runId, RUN_IDS));
  await dbAdmin.delete(pipelineRunsTable).where(inArray(pipelineRunsTable.id, RUN_IDS));
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(pipelineRunsTable).values([
    { id: RUN,       jobId: id("job"),  tenantId: TENANT,       status: "completed", startedAt: new Date(), stages: [] as any },
    { id: OTHER_RUN, jobId: id("job2"), tenantId: OTHER_TENANT, status: "completed", startedAt: new Date(), stages: [] as any },
    { id: CONC_RUN,  jobId: id("job3"), tenantId: TENANT,       status: "running",   startedAt: new Date(), stages: [] as any },
  ]);
});

after(cleanup);

test("emit → getPersistedActivity: events read back through the union view, tenant-scoped", async () => {
  await emitPipelineRunEvent({ id: RUN, tenantId: TENANT }, { type: "run_started", message: "started" });
  await emitPipelineRunEvent({ id: RUN, tenantId: TENANT }, { type: "step_started", stepName: "icp", message: "icp started" });
  await emitPipelineRunEvent({ id: OTHER_RUN, tenantId: OTHER_TENANT }, { type: "run_started", message: "other" });

  // Scoped to TENANT: sees only its own two events, not OTHER_TENANT's.
  const scoped = await getPersistedActivity([TENANT], 100);
  const mine = scoped.filter(e => e.runId === RUN);
  assert.equal(mine.length, 2, "both TENANT events visible");
  assert.ok(mine.every(e => e.runType === "pipeline"), "union view tags run_type=pipeline");
  assert.ok(!scoped.some(e => e.runId === OTHER_RUN), "other tenant's event is not visible under scope [TENANT]");

  // allowed = [] must fail closed (nothing visible).
  assert.equal((await getPersistedActivity([], 100)).length, 0, "empty allowed = nothing");

  // seq is monotonic per run (1,2 for RUN's two events).
  const seqs = mine.map(e => e.id.split(":").pop()).sort();
  assert.deepEqual(seqs, ["1", "2"], "per-run seq is monotonic starting at 1");
});

test("emit: concurrent fire-and-forget emits for one run never drop events (seq retry)", async () => {
  // Fire many emits for the SAME run at once (as runPipeline does via `void`).
  // Without the unique-violation retry these would collide on UNIQUE(run_id,seq)
  // and silently drop; with it, all N must persist with distinct sequential seqs.
  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      emitPipelineRunEvent({ id: CONC_RUN, tenantId: TENANT }, { type: "step_started", stepName: `s${i}`, message: `m${i}` }),
    ),
  );
  const rows = await dbAdmin
    .select({ seq: pipelineRunEventsTable.seq })
    .from(pipelineRunEventsTable)
    .where(inArray(pipelineRunEventsTable.runId, [CONC_RUN]));
  assert.equal(rows.length, N, `all ${N} concurrent events must persist (none dropped), got ${rows.length}`);
  const seqSet = new Set(rows.map(r => r.seq));
  assert.equal(seqSet.size, N, "every persisted event has a distinct seq");
  const sorted = [...seqSet].sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: N }, (_, i) => i + 1), "seqs are gap-free 1..N");
});
