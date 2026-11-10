/**
 * Private PostgreSQL-session fixtures: no normal worker can see these tables.
 * Auth/consent and provider boundaries are mocked; the end handler, stage
 * service, queue SQL, handlers, summary validation and worker are production code.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { mock } from "node:test";
import express from "express";
import { and, desc, eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as real from "@workspace/db";

export async function createHandoffFixture() {
  const client = await real.pool.connect();
  // One private connection owns the temp tables; serialize driver operations,
  // while still allowing simultaneous enqueue callers to race their reads.
  const query = client.query.bind(client);
  let isolated = false;
  let tail: Promise<unknown> = Promise.resolve();
  client.query = ((...args: unknown[]) => {
    const originalText =
      typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
    // Execute the unchanged production erasure policy against this private
    // session's tables; never relax the guard or fall through to public data.
    const text = isolated
      ? originalText
          .replace(/\bpublic\.lexy_erasure_job_blocked\(/g, "pg_temp.lexy_erasure_job_blocked(")
          .replace(/\bpublic\.ats_stage_is_external\(/g, "pg_temp.ats_stage_is_external(")
      : originalText;
    if (text !== originalText) {
      args[0] = typeof args[0] === "string" ? text : { ...(args[0] as object), text };
    }
    if (isolated && /(?:"public"|\bpublic)\s*\./i.test(text)) {
      throw new Error("Fixture query attempted to escape into public tables");
    }
    const result = tail.then(() => (query as any)(...args));
    tail = result.catch(() => undefined);
    return result;
  }) as typeof client.query;
  const db = drizzle(client);
  const tables = [
    real.aiJobsTable,
    real.candidateErasureTombstonesTable,
    real.interviewPlansTable,
    real.interviewSessionsTable,
    real.interviewSummariesTable,
    real.aiDecisionLogTable,
    real.applicationsTable,
    real.recruitingWorkflowsTable,
    real.sourcedCandidatesTable,
    real.candidateEventsTable,
    real.auditLogsTable,
    real.candidatesTable,
    real.jobsTable,
    real.usersTable,
    real.tenantsTable,
    real.userNotificationsTable,
    real.trustEventsTable,
    real.candidateAiConsentTable,
  ];
  let server: http.Server | undefined;
  const state = {
    gradeCalls: 0,
    summaryCalls: 0,
    nextScore: 82 as unknown,
    failSummary: false,
    emails: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    insights: new Map<string, Record<string, unknown>>(),
    matches: [] as { candidateId: string; jobId: string; sessionId: string }[],
    outboundAttempts: 0,
  };

  // Fail closed on un-cloned tables, rather than falling back to public data.
  try {
    for (const table of tables) {
      const name = getTableName(table);
      assert.match(name, /^[a-z_]+$/);
      await client.query(`CREATE TEMP TABLE "${name}" (LIKE public."${name}" INCLUDING ALL)`);
    }
    const migration = readFileSync(
      new URL(
        "../../../../../../scripts/sql/2026-10-11-candidate-erasure-write-barrier.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const guardFunction = migration.match(
      /CREATE OR REPLACE FUNCTION public\.lexy_erasure_job_blocked[\s\S]*?END \$\$;/,
    )?.[0];
    assert.ok(guardFunction, "private fixture must use the real erasure-policy function");
    await client.query(
      guardFunction
        .replace(/\bpublic\./g, "pg_temp.")
        .replace("search_path=pg_catalog,public", "search_path=pg_catalog,pg_temp"),
    );
    await client.query("SET search_path = pg_temp");
    const stageMigration = readFileSync(
      new URL(
        "../../../../../../lib/db/drizzle/0095_ats_stage_initial_write_guard.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const stagePolicy = stageMigration.match(
      /CREATE OR REPLACE FUNCTION public\.ats_stage_is_external[\s\S]*?\$\$;/,
    )?.[0];
    assert.ok(stagePolicy, "private fixture must use the real ATS stage-policy function");
    await client.query(stagePolicy.replace(/\bpublic\./g, "pg_temp."));
    isolated = true;
  } catch (err) {
    client.release(true);
    await real.pool.end();
    throw err;
  }

  try {
    async function stub(relative: string, overrides: Record<string, unknown>) {
      const url = new URL(relative, import.meta.url);
      const source = readFileSync(url, "utf8");
      const names = [
        ...source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g),
      ].map((match) => match[1]);
      const blocked = Object.fromEntries(
        names.map((name) => [
          name,
          () => {
            throw new Error(`Unexpected fixture dependency: ${relative}:${name}`);
          },
        ]),
      );
      mock.module(url, { namedExports: { ...blocked, ...overrides } });
    }

    mock.module("@workspace/db", {
      namedExports: { ...real, db, dbAdmin: db, controlDb: db, forRegion: () => db },
    });
    await stub("../../ai.ts", {
      SUPPORTED_LANGUAGES: { "en-US": { label: "English" } },
      resolveLangMeta: () => ({ label: "English", resolvedKey: "en-US" }),
      azureConfigured: () => false,
      azureSpeechConfigured: () => false,
      deepgramConfigured: () => false,
      generateJSON: async (prompt: string) => {
        if (prompt.startsWith("Rate this interview answer")) {
          state.gradeCalls++;
          return {
            score: state.nextScore,
            feedback: "Explains indexed queries and measured latency.",
          };
        }
        assert.ok(prompt.startsWith("Analyze this interview transcript"));
        state.summaryCalls++;
        if (state.failSummary) throw new Error("fixture summary provider unavailable");
        return {
          overallScore: 99,
          strengths: ["Reduced latency from 120ms to 70ms"],
          weaknesses: [],
          redFlags: [],
          recommendation: "yes",
          recruiterSummary: "The candidate explains indexed queries and measured latency.",
        };
      },
    });
    await stub("../../email.ts", {
      isEmailConfigured: () => true,
      plainToHtml: (text: string) => `<p>${text}</p>`,
      sendEmail: async (args: Record<string, unknown>) => {
        state.emails.push(args);
        return { success: true, messageId: "fixture-only" };
      },
    });
    await stub("../../intelligence.ts", {
      upsertIntelligenceFromInterviewSession: async (
        sessionId: string,
        input: Record<string, unknown>,
      ) => {
        const [summary] = await db
          .select()
          .from(real.interviewSummariesTable)
          .where(eq(real.interviewSummariesTable.interviewSessionId, sessionId));
        assert.ok(summary, "insights must never run ahead of saved evaluation");
        assert.equal(input.overallScore, summary.overallScore);
        const [session] = await db
          .select()
          .from(real.interviewSessionsTable)
          .where(eq(real.interviewSessionsTable.id, sessionId));
        const [plan] = await db
          .select()
          .from(real.interviewPlansTable)
          .where(eq(real.interviewPlansTable.id, session.planId));
        assert.equal(input.tenantId, session.tenantId);
        assert.equal(input.candidateId, session.candidateId);
        assert.equal(input.jobId, plan.jobId);
        state.insights.set(sessionId, input);
        return { id: `fixture-insights:${sessionId}` };
      },
    });
    await stub("../../enrich-candidate.ts", {
      rescoreCandidateForJob: async (candidateId: string, jobId: string) => {
        const [session] = await db
          .select({ sessionId: real.interviewSessionsTable.id })
          .from(real.interviewSessionsTable)
          .innerJoin(
            real.interviewPlansTable,
            eq(real.interviewSessionsTable.planId, real.interviewPlansTable.id),
          )
          .where(
            and(
              eq(real.interviewSessionsTable.candidateId, candidateId),
              eq(real.interviewPlansTable.jobId, jobId),
            ),
          )
          .orderBy(desc(real.interviewSessionsTable.completedAt))
          .limit(1);
        assert.ok(session);
        const [summary] = await db
          .select()
          .from(real.interviewSummariesTable)
          .where(eq(real.interviewSummariesTable.interviewSessionId, session.sessionId));
        assert.ok(summary, "match refresh must never run ahead of saved evaluation");
        state.matches.push({ candidateId, jobId, sessionId: session.sessionId });
        await db
          .update(real.applicationsTable)
          .set({ matchScore: summary.overallScore })
          .where(
            and(
              eq(real.applicationsTable.candidateId, candidateId),
              eq(real.applicationsTable.jobId, jobId),
            ),
          );
        return summary.overallScore;
      },
    });
    await stub("../../candidate-event-logger.ts", {
      logCandidateEvent: async (event: Record<string, unknown>) => {
        state.events.push(event);
      },
      actorTypeFromRole: () => "system",
    });
    await stub("../../interview-session-cookie.ts", {
      TrustEventType: { SESSION_COMPLETED: "session_completed" },
      recordTrustEvent: async () => undefined,
      clearOnComplete: async () => undefined,
      requireInterviewSessionCookie: async (req: any, res: any, next: () => void) => {
        const [session] = await db
          .select()
          .from(real.interviewSessionsTable)
          .where(eq(real.interviewSessionsTable.id, req.params.interviewId));
        if (!session) return res.status(404).json({ error: "Fixture session missing" });
        req.interviewSession = session;
        next();
      },
    });
    await stub("../../ai-consent.ts", {
      CURRENT_AI_CONSENT_VERSION: "fixture-consent",
      hasActiveAiConsent: async () => true,
    });
    await stub("../../../middlewares/requireSameOriginPost.ts", {
      requireSameOriginPost: (_req: unknown, _res: unknown, next: () => void) => next(),
    });
    await stub("../../connectionEngine.ts", {
      recordConnectionEvent: async () => undefined,
      recalculateConnectionScore: async () => undefined,
    });
    await stub("../../run-verification.ts", { runCandidateVerification: async () => null });
    await stub("../../audit.ts", { recordAudit: async () => undefined });

    // Safety net even if a new provider dependency escapes the explicit mocks.
    const fetchActual = globalThis.fetch;
    mock.method(globalThis, "fetch", (input: any, init: any) => {
      const url = new URL(typeof input === "string" ? input : (input.url ?? input.toString()));
      if (server && url.origin === baseUrl()) return fetchActual(input, init);
      state.outboundAttempts++;
      throw new Error("Unexpected outbound provider fetch blocked");
    });
    for (const transport of [http, https]) {
      mock.method(transport, "request", () => {
        state.outboundAttempts++;
        throw new Error("Unexpected outbound provider HTTP request blocked");
      });
    }

    function baseUrl() {
      const address = server?.address();
      assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    }
    async function startServer() {
      const { default: router } = await import("../../../routes/interviews");
      const app = express();
      app.use(express.json());
      app.use("/api", router);
      app.use((err: Error, _req: unknown, res: any, _next: unknown) => {
        res.status(500).json({ error: err.message });
      });
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server!.once("listening", resolve));
    }
    async function seed(stage = "interview_scheduled") {
      const suffix = crypto.randomUUID();
      const tenantId = `handoff-tenant:${suffix}`;
      const candidateId = `handoff-candidate:${suffix}`;
      const jobId = `handoff-job:${suffix}`;
      const recruiterId = `handoff-recruiter:${suffix}`;
      await db.insert(real.usersTable).values({
        id: recruiterId,
        tenantId,
        name: "Fixture Recruiter",
        email: `recruiter+${suffix}@handoff.invalid`,
        passwordHash: "fixture-no-login",
      });
      await db.insert(real.candidatesTable).values({
        id: candidateId,
        tenantId,
        firstName: "Fixture",
        lastName: "Candidate",
        email: `candidate+${suffix}@handoff.invalid`,
        createdById: recruiterId,
      });
      await db.insert(real.jobsTable).values({
        id: jobId,
        tenantId,
        title: "Isolated handoff test",
        description: "Fixture only",
        assignedRecruiterId: recruiterId,
      });
      const [app] = await db
        .insert(real.applicationsTable)
        .values({
          tenantId,
          candidateId,
          jobId,
          stage: stage as any,
        })
        .returning();
      const [plan] = await db
        .insert(real.interviewPlansTable)
        .values({
          tenantId,
          jobId,
          title: "Fixture interview",
          language: "en-US",
          questions: [{ id: "q1", text: "How did you reduce query latency?" }],
        })
        .returning();
      return { tenantId, candidateId, jobId, recruiterId, app, plan };
    }
    type SeededFixture = Awaited<ReturnType<typeof seed>>;
    async function sessionFor(seed: SeededFixture) {
      const [session] = await db
        .insert(real.interviewSessionsTable)
        .values({
          tenantId: seed.tenantId,
          candidateId: seed.candidateId,
          planId: seed.plan.id,
          applicationId: seed.app.id,
          status: "in_progress",
          language: "en-US",
          totalQuestions: 1,
          answers: [
            {
              questionId: "q1",
              answer: "I used indexed queries and reduced latency from 120ms to 70ms.",
              score: null,
            },
          ],
        })
        .returning();
      return session;
    }
    async function end(sessionId: string) {
      const response = await fetch(`${baseUrl()}/api/interviews/${sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return { status: response.status, body: (await response.json()) as any };
    }
    async function rowsFor(sessionId: string) {
      return db
        .select()
        .from(real.aiJobsTable)
        .where(eq(real.aiJobsTable.interviewSessionId, sessionId));
    }
    async function settled(sessionId: string) {
      await waitFor(async () => {
        const rows = await rowsFor(sessionId);
        return rows.length === 3 && rows.every((row) => row.status === "completed");
      });
    }
    async function rejectEnqueue(type: string | null) {
      await db.execute(sql`DROP TRIGGER IF EXISTS fixture_reject_enqueue ON ${real.aiJobsTable}`);
      if (!type) return;
      assert.ok(["summarize_interview", "match_candidate_to_job"].includes(type));
      await client.query(`CREATE OR REPLACE FUNCTION pg_temp.fixture_reject_enqueue()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type::text = '${type}' THEN RAISE EXCEPTION 'fixture enqueue unavailable'; END IF;
        RETURN NEW;
      END $$`);
      await client.query(`CREATE TRIGGER fixture_reject_enqueue BEFORE INSERT ON ai_jobs
      FOR EACH ROW EXECUTE FUNCTION pg_temp.fixture_reject_enqueue()`);
    }
    async function close() {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((err) => (err ? reject(err) : resolve())),
        );
      mock.restoreAll();
      client.release(true); // Destroys the private session and ALL its temp tables.
      await real.pool.end();
    }
    return {
      db,
      state,
      client,
      startServer,
      seed,
      sessionFor,
      end,
      rowsFor,
      settled,
      rejectEnqueue,
      close,
    };
  } catch (err) {
    mock.restoreAll();
    client.release(true);
    await real.pool.end();
    throw err;
  }
}

export async function waitFor(check: () => Promise<boolean>, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for isolated handoff state");
}
