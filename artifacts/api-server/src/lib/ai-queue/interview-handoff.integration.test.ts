import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@workspace/db";
import { createHandoffFixture, waitFor } from "./fixtures/handoff-fixture";

test("authorized interview end → private real PostgreSQL queue → real worker handoff", async (t) => {
  const f = await createHandoffFixture();
  let worker: typeof import("./worker") | undefined;
  try {
    const queue = await import("./queue");

    await t.test(
      "private erasure policy rejects erased identities, tombstones and missing sessions",
      async () => {
        const seed = await f.seed();
        const session = await f.sessionFor(seed);
        const blocked = async () => {
          const result = await f.db.execute(sql`SELECT public.lexy_erasure_job_blocked(
          ${JSON.stringify({ candidateId: seed.candidateId, sessionId: session.id })}::jsonb,
          ${session.id}::text) AS blocked`);
          return result.rows[0]?.blocked;
        };
        assert.equal(await blocked(), false);
        await f.db
          .update(schema.candidatesTable)
          .set({ dataErasedAt: new Date() })
          .where(eq(schema.candidatesTable.id, seed.candidateId));
        assert.equal(await blocked(), true);
        await f.db
          .update(schema.candidatesTable)
          .set({ dataErasedAt: null })
          .where(eq(schema.candidatesTable.id, seed.candidateId));
        await f.db
          .insert(schema.candidateErasureTombstonesTable)
          .values({ subjectId: seed.candidateId });
        assert.equal(await blocked(), true);
        await f.db
          .delete(schema.candidateErasureTombstonesTable)
          .where(eq(schema.candidateErasureTombstonesTable.subjectId, seed.candidateId));
        await f.db
          .delete(schema.interviewSessionsTable)
          .where(eq(schema.interviewSessionsTable.id, session.id));
        assert.equal(await blocked(), true);
        assert.equal(
          await queue.enqueueAiJob({ type: "score_answer", payload: { sessionId: session.id } }),
          null,
        );
      },
    );

    await t.test("claimed rows retain typed retry and session metadata", async () => {
      const seed = await f.seed();
      const session = await f.sessionFor(seed);
      const queued = await queue.enqueueAiJob({
        type: "score_answer",
        payload: {},
        maxAttempts: 2,
        tenantId: seed.tenantId,
        interviewSessionId: session.id,
        dedupeKey: "fixture-claim-contract",
      });
      assert.ok(queued);
      const claimed = await queue.claimNextJob("fixture-claim-worker");
      assert.ok(claimed);
      assert.equal(claimed.retryCount, 1);
      assert.equal(claimed.maxAttempts, 2);
      assert.equal(claimed.interviewSessionId, session.id);
      assert.equal(claimed.tenantId, seed.tenantId);
      assert.equal(claimed.lockedBy, "fixture-claim-worker");
      assert.ok(claimed.startedAt instanceof Date);
      assert.ok(Number.isFinite(claimed.startedAt.getTime()));
      assert.deepEqual(claimed.payload, {});
      await queue.completeJob(claimed.id, { fixture: true });
    });

    await t.test("concurrent enqueue requests share the database dedupe winner", async () => {
      const key = `fixture-concurrent:${crypto.randomUUID()}`;
      const rows = await Promise.all(
        Array.from({ length: 8 }, () =>
          queue.enqueueAiJob({ type: "score_answer", payload: {}, dedupeKey: key }),
        ),
      );
      assert.ok(rows.every(Boolean));
      assert.equal(new Set(rows.map((row) => row!.id)).size, 1);
      // Complete before starting the worker: this fixture tests dedupe only.
      const claimed = await queue.claimNextJob("fixture-dedupe-worker");
      assert.equal(claimed?.id, rows[0]!.id);
      await queue.completeJob(rows[0]!.id, { fixture: true });
    });

    await f.startServer();
    worker = await import("./worker");
    worker.startAiWorker();

    await t.test(
      "new evidence, legacy completed match, duplicate end, and recruiter review",
      async () => {
        const seed = await f.seed();
        await f.db.insert(schema.aiJobsTable).values({
          type: "match_candidate_to_job",
          status: "completed",
          payload: { candidateId: seed.candidateId, jobId: seed.jobId },
          dedupeKey: `match:${seed.candidateId}:${seed.jobId}`,
          interviewSessionId: "historical-fixture",
          tenantId: seed.tenantId,
        });
        const first = await f.sessionFor(seed);
        const response = await f.end(first.id);
        assert.equal(response.status, 200);
        await f.settled(first.id);
        const aiCalls = [f.state.gradeCalls, f.state.summaryCalls];
        assert.equal((await f.end(first.id)).status, 200);
        assert.deepEqual([f.state.gradeCalls, f.state.summaryCalls], aiCalls);
        assert.equal((await f.rowsFor(first.id)).length, 3);

        f.state.nextScore = 61;
        const second = await f.sessionFor(seed);
        assert.equal((await f.end(second.id)).status, 200);
        await f.settled(second.id);
        const [app] = await f.db
          .select()
          .from(schema.applicationsTable)
          .where(eq(schema.applicationsTable.id, seed.app.id));
        assert.equal(app.stage, "interview_completed");
        assert.equal(app.matchScore, 61);
        assert.equal(f.state.insights.get(first.id)!.overallScore, 82);
        assert.equal(f.state.insights.get(second.id)!.overallScore, 61);
        assert.equal(
          f.state.matches.filter((row) => row.candidateId === seed.candidateId).length,
          2,
        );
        const changes = await f.db
          .select()
          .from(schema.candidateEventsTable)
          .where(
            and(
              eq(schema.candidateEventsTable.candidateId, seed.candidateId),
              eq(schema.candidateEventsTable.eventType, "STAGE_CHANGED"),
            ),
          );
        assert.equal(changes.length, 1, "later completion must not invent another stage move");
        const notifications = await f.db
          .select()
          .from(schema.userNotificationsTable)
          .where(eq(schema.userNotificationsTable.userId, seed.recruiterId));
        assert.equal(notifications.length, 2);
        const emails = f.state.emails.filter(
          (email) => (email.audit as any)?.tenantId === seed.tenantId,
        );
        assert.equal(
          emails.length,
          4,
          "one recruiter and one candidate message per session, none on duplicate",
        );
      },
    );
    await t.test(
      "ATS ownership preserves the hiring stage without blocking completed interview evidence",
      async () => {
        const seed = await f.seed();
        await f.db.insert(schema.recruitingWorkflowsTable).values({
          tenantId: seed.tenantId,
          jobId: seed.jobId,
          candidateId: seed.candidateId,
          journeyId: crypto.randomUUID(),
          journeyVersion: 1,
          interviewPath: "ai",
          createdById: crypto.randomUUID(),
          steps: sql`'[{"key":"hiring_decision","atsStageOwnership":{"status":"external"}}]'::jsonb`,
        });
        const session = await f.sessionFor(seed);
        assert.equal((await f.end(session.id)).status, 200);
        await f.settled(session.id);
        const [app] = await f.db
          .select()
          .from(schema.applicationsTable)
          .where(eq(schema.applicationsTable.id, seed.app.id));
        assert.equal(app.stage, "interview_scheduled");
        assert.equal((await f.rowsFor(session.id)).length, 3);
        assert.ok(
          f.state.insights.get(session.id),
          "interview grading and downstream evidence still complete",
        );
      },
    );

    await t.test("missing parent enqueue reports failure and a repeated end recovers", async () => {
      const seed = await f.seed();
      const session = await f.sessionFor(seed);
      await f.rejectEnqueue("summarize_interview");
      assert.equal((await f.end(session.id)).status, 500);
      assert.equal((await f.rowsFor(session.id)).length, 0);
      await f.rejectEnqueue(null);
      assert.equal((await f.end(session.id)).status, 200);
      await f.settled(session.id);
    });

    await t.test(
      "downstream persistence failure retries the parent without regrading",
      async () => {
        const seed = await f.seed();
        const session = await f.sessionFor(seed);
        await f.rejectEnqueue("match_candidate_to_job");
        assert.equal((await f.end(session.id)).status, 200);
        await waitFor(async () =>
          (await f.rowsFor(session.id)).some(
            (row) =>
              row.type === "summarize_interview" && row.status === "pending" && !!row.lastError,
          ),
        );
        const counts = [f.state.gradeCalls, f.state.summaryCalls];
        await f.rejectEnqueue(null);
        await f.db
          .update(schema.aiJobsTable)
          .set({ runAt: new Date() })
          .where(
            and(
              eq(schema.aiJobsTable.interviewSessionId, session.id),
              eq(schema.aiJobsTable.type, "summarize_interview"),
            ),
          );
        await f.settled(session.id);
        assert.deepEqual([f.state.gradeCalls, f.state.summaryCalls], counts);
        const parent = (await f.rowsFor(session.id)).find(
          (row) => row.type === "summarize_interview",
        )!;
        assert.equal(parent.retryCount, 2);
        assert.equal((parent.result as any).skipped, "summary_exists");
      },
    );

    await t.test(
      "provider failure exhausts retries rather than fabricating an evaluation",
      async () => {
        const seed = await f.seed();
        const session = await f.sessionFor(seed);
        f.state.failSummary = true;
        await queue.enqueueAiJob({
          type: "summarize_interview",
          payload: { sessionId: session.id },
          interviewSessionId: session.id,
          dedupeKey: `summarize:${session.id}`,
          tenantId: seed.tenantId,
          maxAttempts: 2,
        });
        await waitFor(async () => (await f.rowsFor(session.id)).some((row) => !!row.lastError));
        await f.db
          .update(schema.aiJobsTable)
          .set({ runAt: new Date() })
          .where(eq(schema.aiJobsTable.interviewSessionId, session.id));
        await waitFor(async () =>
          (await f.rowsFor(session.id)).some((row) => row.status === "failed"),
        );
        f.state.failSummary = false;
        const jobs = await f.rowsFor(session.id);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].retryCount, 2);
        const summaries = await f.db
          .select()
          .from(schema.interviewSummariesTable)
          .where(eq(schema.interviewSummariesTable.interviewSessionId, session.id));
        assert.equal(summaries.length, 0);
        assert.ok(await queue.retryJob(jobs[0].id));
        await f.settled(session.id);
      },
    );

    await t.test(
      "malformed grades fail without a summary or downstream signals; a controlled retry recovers",
      async () => {
        const { handlers } = await import("./handlers");
        const seed = await f.seed();
        const session = await f.sessionFor(seed);
        const summaryCalls = f.state.summaryCalls;
        const insights = f.state.insights.size;
        const matches = f.state.matches.length;
        try {
          for (const invalid of [undefined, null, "82", NaN, -1, 101]) {
            f.state.nextScore = invalid;
            await assert.rejects(
              () =>
                handlers.summarize_interview({
                  payload: { sessionId: session.id },
                } as any),
              /no valid assessment score/,
            );
            const summaries = await f.db
              .select()
              .from(schema.interviewSummariesTable)
              .where(eq(schema.interviewSummariesTable.interviewSessionId, session.id));
            assert.equal(summaries.length, 0);
            assert.equal((await f.rowsFor(session.id)).length, 0, "no downstream queue work");
          }
          assert.equal(f.state.insights.size, insights);
          assert.equal(f.state.matches.length, matches);
          assert.equal(
            f.state.summaryCalls,
            summaryCalls,
            "no summary generation without graded evidence",
          );
          f.state.nextScore = 0;
          await handlers.summarize_interview({ payload: { sessionId: session.id } } as any);
          const [summary] = await f.db
            .select()
            .from(schema.interviewSummariesTable)
            .where(eq(schema.interviewSummariesTable.interviewSessionId, session.id));
          assert.equal(summary.overallScore, 0, "real zero survives instead of generated 99");
          assert.equal(f.state.summaryCalls, summaryCalls + 1);
        } finally {
          f.state.nextScore = 82;
        }
      },
    );

    await t.test("completed and terminal recruiter stages never move backwards", async () => {
      for (const stage of ["interview_completed", "offer", "hired", "rejected"] as const) {
        const seed = await f.seed(stage);
        const session = await f.sessionFor(seed);
        assert.equal((await f.end(session.id)).status, 200);
        await f.settled(session.id);
        const [app] = await f.db
          .select()
          .from(schema.applicationsTable)
          .where(eq(schema.applicationsTable.id, seed.app.id));
        assert.equal(app.stage, stage);
      }
    });
    assert.equal(f.state.outboundAttempts, 0, "no real provider or email request may escape");
  } finally {
    if (worker) await worker.stopAiWorker();
    await f.close();
  }
});
