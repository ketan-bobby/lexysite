import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { EnqueueArgs } from "./queue";
import { enqueueInterviewFollowups } from "./interview-followups";

const context = {
  sessionId: "session-one",
  candidateId: "candidate-one",
  jobId: "job-one",
  tenantId: "tenant-one",
};

/** Mock queue retains completed keys just like the real database index. */
function fixtureQueue() {
  const rows = new Map<string, EnqueueArgs & { id: string; status: "completed" }>();
  const calls: EnqueueArgs[] = [];
  let rejectType: EnqueueArgs["type"] | null = null;
  async function enqueue(args: EnqueueArgs) {
    calls.push(args);
    if (args.type === rejectType) return null;
    assert.ok(args.dedupeKey);
    const existing = rows.get(args.dedupeKey);
    if (existing) return existing;
    const row = { ...args, id: `fixture-${rows.size}`, status: "completed" as const };
    rows.set(args.dedupeKey, row);
    return row;
  }
  return {
    rows,
    calls,
    enqueue,
    reject(type: typeof rejectType) {
      rejectType = type;
    },
  };
}

test("a new interview refreshes despite a completed legacy candidate/job task", async () => {
  const q = fixtureQueue();
  const legacyKey = `match:${context.candidateId}:${context.jobId}`;
  q.rows.set(legacyKey, {
    id: "old-task",
    status: "completed",
    type: "match_candidate_to_job",
    payload: { candidateId: context.candidateId, jobId: context.jobId },
    dedupeKey: legacyKey,
    interviewSessionId: "old-session",
  });
  await enqueueInterviewFollowups(context, q.enqueue);
  assert.equal(q.rows.size, 3);
  const match = q.calls.find((j) => j.type === "match_candidate_to_job")!;
  assert.notEqual(match.dedupeKey, legacyKey);
  assert.equal(match.interviewSessionId, context.sessionId);
  assert.equal(q.rows.get(legacyKey)!.interviewSessionId, "old-session");
});

test("two completed interviews for the same candidate/job get distinct refreshes", async () => {
  const q = fixtureQueue();
  await enqueueInterviewFollowups(context, q.enqueue);
  await enqueueInterviewFollowups({ ...context, sessionId: "session-two" }, q.enqueue);
  const matches = [...q.rows.values()].filter((j) => j.type === "match_candidate_to_job");
  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].dedupeKey, matches[1].dedupeKey);
  assert.deepEqual(
    matches.map((j) => j.interviewSessionId),
    ["session-one", "session-two"],
  );
});

test("concurrent and repeated same-interview requests reuse completed child tasks", async () => {
  const q = fixtureQueue();
  await Promise.all(Array.from({ length: 5 }, () => enqueueInterviewFollowups(context, q.enqueue)));
  await enqueueInterviewFollowups(context, q.enqueue);
  assert.equal(q.rows.size, 2);
  for (const row of q.rows.values()) assert.equal(row.interviewSessionId, context.sessionId);
});

test("tenant, payload, priorities and insights-before-match order are preserved", async () => {
  const q = fixtureQueue();
  await enqueueInterviewFollowups(context, q.enqueue);
  assert.deepEqual(
    q.calls.map((j) => j.type),
    ["generate_candidate_insights", "match_candidate_to_job"],
  );
  assert.deepEqual(
    q.calls.map((j) => j.priority),
    [5, 1],
  );
  assert.deepEqual(q.calls[0].payload, { sessionId: context.sessionId });
  assert.deepEqual(q.calls[1].payload, { candidateId: context.candidateId, jobId: context.jobId });
  assert.equal(q.calls[0].dedupeKey, `insights:${context.sessionId}`);
  for (const call of q.calls) assert.equal(call.tenantId, context.tenantId);
});

test("failed match enqueue throws; retry preserves insights and fills the missing child", async () => {
  const q = fixtureQueue();
  q.reject("match_candidate_to_job");
  await assert.rejects(
    enqueueInterviewFollowups(context, q.enqueue),
    /failed to enqueue match_candidate_to_job/,
  );
  const insightsId = [...q.rows.values()][0].id;
  q.reject(null);
  await enqueueInterviewFollowups(context, q.enqueue);
  assert.equal(q.rows.size, 2);
  assert.equal(q.rows.get(`insights:${context.sessionId}`)!.id, insightsId);
});

test("failed insights enqueue throws and does not enqueue match prematurely", async () => {
  const q = fixtureQueue();
  q.reject("generate_candidate_insights");
  await assert.rejects(
    enqueueInterviewFollowups(context, q.enqueue),
    /failed to enqueue generate_candidate_insights/,
  );
  assert.equal(q.calls.length, 1);
  assert.equal(q.rows.size, 0);
});

test("missing job or candidate skips employer followups", async () => {
  const q = fixtureQueue();
  await enqueueInterviewFollowups({ ...context, jobId: null }, q.enqueue);
  await enqueueInterviewFollowups({ ...context, candidateId: null }, q.enqueue);
  assert.equal(q.calls.length, 0);
});

test("the real handler uses the tested helper after resolving the session's job", () => {
  const source = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
  const chain = source.slice(
    source.indexOf("async function chainDownstream("),
    source.indexOf("/* ── generate_candidate_insights"),
  );
  assert.match(chain, /await enqueueInterviewFollowups\(/);
  assert.match(chain, /sessionId: session\.id/);
  assert.match(chain, /tenantId: session\.tenantId/);
  assert.match(chain, /candidateId: session\.candidateId/);
  assert.match(chain, /enqueueAiJob/);
  assert.doesNotMatch(chain, /dedupeKey:/);
});
