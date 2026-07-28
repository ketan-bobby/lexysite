/**
 * reconcile.test.ts — Boot-time pipeline_runs reconciliation
 *
 * Verifies reconcileStalePipelineRuns():
 *   • a stuck `running` run older than the threshold is flipped to `interrupted`
 *     (NOT `failed`), with completed_at + error stamped — the deploy-interrupt
 *     audit trail terminates honestly;
 *   • a freshly-started `running` run (inside the threshold) is left untouched —
 *     the safety margin so we never clobber a legitimately-active run;
 *   • a `completed` run is never touched.
 *
 * Rows are seeded straight onto pipeline_runs via dbAdmin (BYPASSRLS) so we
 * exercise the reconcile logic deterministically. pipeline_runs has no FK to
 * tenants/jobs, so we seed with plain-text ids. All ids are prefixed `rspr_`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { dbAdmin, pipelineRunsTable } from "@workspace/db";
import { reconcileStalePipelineRuns, STALE_PIPELINE_RUN_MINUTES } from "./reconcile";

const P = "rspr_";
const id = (s: string) => P + s;

const TENANT_ID = id("tenant");
const JOB_ID = id("job");
const STALE_RUN = id("stale_running");
const STALE_QUEUED = id("stale_queued");
const FRESH_RUN = id("fresh_running");
const DONE_RUN = id("completed");
const RUN_IDS = [STALE_RUN, STALE_QUEUED, FRESH_RUN, DONE_RUN];

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function cleanup() {
  await dbAdmin.delete(pipelineRunsTable).where(inArray(pipelineRunsTable.id, RUN_IDS));
}

before(async () => {
  await cleanup();
  const beyond = STALE_PIPELINE_RUN_MINUTES + 15; // safely past the threshold
  await dbAdmin.insert(pipelineRunsTable).values([
    { id: STALE_RUN,    jobId: JOB_ID, tenantId: TENANT_ID, status: "running",   startedAt: minsAgo(beyond), stages: [] as any },
    { id: STALE_QUEUED, jobId: JOB_ID, tenantId: TENANT_ID, status: "queued",    startedAt: minsAgo(beyond), stages: [] as any },
    { id: FRESH_RUN,    jobId: JOB_ID, tenantId: TENANT_ID, status: "running",   startedAt: minsAgo(0),      stages: [] as any },
    { id: DONE_RUN,     jobId: JOB_ID, tenantId: TENANT_ID, status: "completed", startedAt: minsAgo(beyond), completedAt: minsAgo(beyond), stages: [] as any },
  ]);
});

after(cleanup);

test("stale running/queued runs are flipped to interrupted; fresh + completed are untouched", async () => {
  const count = await reconcileStalePipelineRuns();
  assert.ok(count >= 2, `expected at least the 2 seeded stale runs to reconcile, got ${count}`);

  const rows = await dbAdmin.select().from(pipelineRunsTable).where(inArray(pipelineRunsTable.id, RUN_IDS));
  const byId = new Map(rows.map(r => [r.id, r]));

  const stale = byId.get(STALE_RUN)!;
  assert.equal(stale.status, "interrupted", "stale running run must become interrupted (not failed)");
  assert.ok(stale.completedAt, "interrupted run must have completedAt stamped");
  assert.ok(stale.error, "interrupted run must record an error reason");

  assert.equal(byId.get(STALE_QUEUED)!.status, "interrupted", "stale queued run must become interrupted");

  assert.equal(byId.get(FRESH_RUN)!.status, "running", "fresh run inside the threshold must be left running");
  assert.equal(byId.get(DONE_RUN)!.status, "completed", "already-terminal run must be untouched");
});
