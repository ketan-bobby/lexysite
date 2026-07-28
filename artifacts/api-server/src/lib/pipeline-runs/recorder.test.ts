/**
 * recorder.test.ts — durability guarantees of the pipeline-run audit trail.
 *
 * 3a  RETRY: emits are fire-and-forget, so several for the same run race on the
 *     computed MAX(seq)+1 and collide on UNIQUE(run_id, seq). The 23505 retry
 *     loop must give each racer the NEXT free slot instead of dropping it. We
 *     fire many concurrent emits and assert every one persisted with a unique,
 *     contiguous seq (1..N) — no gaps, no duplicates, no lost events.
 *
 * 3b  RETENTION: prunePipelineRunEvents(retentionDays) deletes only NON-milestone
 *     events older than the cutoff. Milestone events (run_*, step_completed) are
 *     kept forever; recent non-milestone events are kept. We seed a mix straddling
 *     the cutoff and assert exactly the doomed rows are removed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pipelineRunEventsTable,
  pipelineRunsTable,
  jobsTable,
  tenantsTable,
} from "@workspace/db";
import { emitPipelineRunEvent, prunePipelineRunEvents } from "./recorder";

const T = "glrec_t";
const JOB = "glrec_job";
const RUN_RETRY = "glrec_run_retry";
const RUN_RETENTION = "glrec_run_retention";

async function eventsFor(runId: string) {
  return dbAdmin
    .select({ seq: pipelineRunEventsTable.seq, type: pipelineRunEventsTable.type })
    .from(pipelineRunEventsTable)
    .where(and(eq(pipelineRunEventsTable.tenantId, T), eq(pipelineRunEventsTable.runId, runId)));
}

async function cleanup() {
  await dbAdmin.delete(pipelineRunEventsTable).where(eq(pipelineRunEventsTable.tenantId, T));
  await dbAdmin.delete(pipelineRunsTable).where(eq(pipelineRunsTable.tenantId, T));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, T));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, T));
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({ id: T, name: "GL Recorder Tenant", slug: T, plan: "enterprise" });
  await dbAdmin.insert(jobsTable).values({ id: JOB, tenantId: T, title: "Engineer", description: "Build things", status: "active" });
  // Parent runs the FK'd events hang off of.
  await dbAdmin.insert(pipelineRunsTable).values([
    { id: RUN_RETRY, jobId: JOB, tenantId: T, triggeredBy: "user", status: "running", stages: [] },
    { id: RUN_RETENTION, jobId: JOB, tenantId: T, triggeredBy: "user", status: "running", stages: [] },
  ] as any);
});
after(cleanup);

test("3a: concurrent emits for one run all persist with unique contiguous seqs (23505 retry)", async () => {
  const N = 25;
  // Fire all at once so many collide on the same computed MAX(seq)+1.
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      emitPipelineRunEvent(
        { id: RUN_RETRY, tenantId: T },
        { type: "step_started" as any, stepName: "sourcing", message: `event ${i}` },
      ),
    ),
  );

  const rows = await eventsFor(RUN_RETRY);
  assert.equal(rows.length, N, "every concurrent emit persisted (none dropped)");

  const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1), "seqs are the contiguous set 1..N");
  assert.equal(new Set(seqs).size, N, "no duplicate seq");
});

test("3b: prune deletes old non-milestone events but keeps milestones and recent events", async () => {
  const now = Date.now();
  const old = new Date(now - 200 * 24 * 60 * 60_000); // well past a 90d cutoff
  const recent = new Date(now - 1 * 24 * 60 * 60_000); // inside retention

  // seq is a plain int here (we set it directly — no concurrency in this seed).
  await dbAdmin.insert(pipelineRunEventsTable).values([
    { tenantId: T, runId: RUN_RETENTION, seq: 1, type: "step_started", stepName: "sourcing", message: "old noise", timestamp: old },
    { tenantId: T, runId: RUN_RETENTION, seq: 2, type: "step_progress", stepName: "sourcing", message: "old noise 2", timestamp: old },
    { tenantId: T, runId: RUN_RETENTION, seq: 3, type: "step_completed", stepName: "sourcing", message: "old milestone", timestamp: old },
    { tenantId: T, runId: RUN_RETENTION, seq: 4, type: "run_completed", message: "old run milestone", timestamp: old },
    { tenantId: T, runId: RUN_RETENTION, seq: 5, type: "step_started", stepName: "screening", message: "recent noise", timestamp: recent },
  ] as any);

  const result = await prunePipelineRunEvents({ retentionDays: 90 });
  assert.ok(!result.error, `prune should not error: ${result.error ?? ""}`);
  assert.equal(result.deleted, 2, "exactly the two OLD non-milestone rows were deleted");

  const remaining = await eventsFor(RUN_RETENTION);
  const remainingSeqs = remaining.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(remainingSeqs, [3, 4, 5], "old milestones (3,4) + recent noise (5) survive");

  const types = remaining.map((r) => r.type).sort();
  assert.deepEqual(types, ["run_completed", "step_completed", "step_started"].sort());
});
