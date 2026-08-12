/**
 * recorder.test.ts — durability of the agent-run event stream.
 *
 * emitRunEvent assigns seq = MAX(seq)+1 in-statement; CONCURRENT emitters for
 * the same run can compute the same value and collide on UNIQUE(run_id, seq).
 * The 23505 retry loop must give every racer the next free slot instead of
 * silently dropping its event. We fire many concurrent emits and assert all
 * persisted with unique, contiguous seqs (1..N) — no gaps, no dupes, no loss.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { dbAdmin, agentRunsTable, agentRunEventsTable, tenantsTable } from "@workspace/db";
import { emitRunEvent } from "./recorder";

const T = "arrec_t";
const RUN = "arrec_run_retry";

async function cleanup() {
  await dbAdmin.delete(agentRunEventsTable).where(eq(agentRunEventsTable.tenantId, T));
  await dbAdmin.delete(agentRunsTable).where(eq(agentRunsTable.tenantId, T));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, T));
}

before(async () => {
  await cleanup();
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: T, name: "AR Recorder Tenant", slug: T, plan: "enterprise" } as any);
  await dbAdmin.insert(agentRunsTable).values({
    id: RUN,
    tenantId: T,
    workOrderId: "arrec_job",
    agentType: "sourcing",
    status: "running",
  } as any);
});
after(cleanup);

test("concurrent emits for one run all persist with unique contiguous seqs (23505 retry)", async () => {
  const N = 25;
  // Fire all at once so many collide on the same computed MAX(seq)+1.
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      emitRunEvent({ id: RUN, tenantId: T }, { type: "step_progress", message: `evt ${i}` }),
    ),
  );
  const rows = await dbAdmin
    .select({ seq: agentRunEventsTable.seq })
    .from(agentRunEventsTable)
    .where(and(eq(agentRunEventsTable.tenantId, T), eq(agentRunEventsTable.runId, RUN)));
  assert.equal(rows.length, N, `expected all ${N} events persisted, got ${rows.length}`);
  const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(
    seqs,
    Array.from({ length: N }, (_, i) => i + 1),
    "seqs must be unique and contiguous 1..N",
  );
});
