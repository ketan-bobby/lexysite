import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { test } from "node:test";
import express from "express";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  aiJobsTable,
  candidateEvaluationsTable,
  candidatesTable,
  interviewPlansTable,
  interviewSessionsTable,
  interviewSummariesTable,
  jobsTable,
  tenantsTable,
  usersTable,
  dbAdmin,
  pool,
  qorInterviewRequestsTable as requests,
  qorPartnerCredentialsTable as credentials,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { qorDigest } from "../lib/qor-interview-policy";
import { scrubQorInterviewRequests } from "../lib/qor-interview-erasure";
import { createSessionRevocationGuard } from "../middlewares/sessionRevocation";
import { withTenantContext } from "../middlewares/withTenantContext";
import { createQorInterviewRouter } from "./qor-interviews";

// Generate only the native table shape needed by the HTTP harness; apply the
// actual additive QOR migration below, not a hand-maintained QOR table double.
async function nativeTables(tables: PgTable[]) {
  const names = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const literals = (literal: string) => `'${literal.replaceAll("'", "''")}'`;
  const enums = new Map<string, string[]>();
  const fragments = tables.map((table) => {
    const config = getTableConfig(table);
    const columns = config.columns.map((col) => {
      const type = col.getSQLType();
      if (col.enumValues?.length && /^[a-z][a-z0-9_]*$/.test(type) && type !== "text")
        enums.set(type, [...col.enumValues]);
      return `${names(col.name)} ${type}${col.primary ? " PRIMARY KEY" : ""}`;
    });
    return `CREATE TABLE ${names(config.name)} (${columns.join(",")});`;
  });
  const enumSql = [...enums].map(
    ([name, values]) => `CREATE TYPE ${names(name)} AS ENUM (${values.map(literals).join(",")});`,
  );
  await pool.query([...enumSql, ...fragments].join("\n"));
}

test("QOR polling and human approvals against isolated PostgreSQL", async (t) => {
  assert.ok(
    process.env.QOR_FIXTURE_DATA_DIRECTORY?.includes("/qor-test-"),
    "Start the sandbox with the dedicated command; no shared database is allowed.",
  );
  const {
    rows: [identity],
  } = await pool.query(
    "SELECT current_setting('data_directory') AS directory, inet_server_addr() AS address",
  );
  assert.equal(identity.directory, process.env.QOR_FIXTURE_DATA_DIRECTORY);
  assert.equal(identity.address, null);
  t.after(() => pool.end());
  await nativeTables([
    tenantsTable,
    usersTable,
    jobsTable,
    candidatesTable,
    interviewPlansTable,
    interviewSessionsTable,
    interviewSummariesTable,
    candidateEvaluationsTable,
    aiJobsTable,
  ]);
  await pool.query(
    "CREATE TABLE candidate_erasure_tombstones(subject_id text PRIMARY KEY); CREATE ROLE lexy_app",
  );
  await pool.query(
    await readFile(
      new URL("../../../../lib/db/drizzle/0116_qor_interview_requests.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(`ALTER TABLE interview_plans ALTER COLUMN created_at SET DEFAULT now();
    ALTER TABLE interview_sessions ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN answers SET DEFAULT '[]'::jsonb;`);

  const tenantA = "employer-fixture-a";
  const tenantB = "employer-fixture-b";
  await dbAdmin.insert(tenantsTable).values([
    { id: tenantA, slug: tenantA, name: "Synthetic employer A", status: "active", region: "us" },
    { id: tenantB, slug: tenantB, name: "Synthetic employer B", status: "active", region: "us" },
  ]);
  const setupUser = async (
    tenantId: string,
    actor: string,
    role: "tenant_admin" | "recruiter" = "tenant_admin",
  ) => {
    await dbAdmin.insert(usersTable).values({
      id: actor,
      tenantId,
      role,
      status: "active",
      name: actor,
      email: `${actor}@example.invalid`,
      passwordHash: "synthetic-non-password-hash",
    });
    return issueToken({ userId: actor, role, tenantId, credentialVersion: "fixture-epoch" });
  };
  const reviewerA = await setupUser(tenantA, "reviewer-a");
  const reviewerB = await setupUser(tenantB, "reviewer-b");
  const recruiter = await setupUser(tenantA, "recruiter-a", "recruiter");
  const tokenFor = async (tenantId: string, canRead = true, canCreate = true, expired = false) => {
    const value = `qor_${randomBytes(32).toString("base64url")}`;
    await dbAdmin.insert(credentials).values({
      digest: qorDigest(value),
      tenantId,
      canRead,
      canCreate,
      expiresAt: new Date(Date.now() + (expired ? -3600000 : 3600000)),
    });
    return value;
  };
  const firstKey = await tokenFor(tenantA),
    otherKey = await tokenFor(tenantB);
  const readOnlyKey = await tokenFor(tenantA, true, false),
    createOnlyKey = await tokenFor(tenantA, false, true);
  const expiredKey = await tokenFor(tenantA, true, true, true);

  const job = {
    externalId: "qor-job-017",
    title: "Support Lead",
    brief: "Handle support escalations.",
    revision: "3",
    approvalRef: "approved-009",
  };
  const input = {
    externalApplicationId: "qor-app-042",
    selectionRef: "selected-021",
    job,
    candidate: {
      externalId: "qor-candidate-042",
      firstName: "Taylor",
      lastName: "Example",
      email: "taylor@example.invalid",
    },
  };
  const binding = {
    jobId: "fixture-work-order",
    candidateId: "fixture-candidate",
    planId: "fixture-plan",
  };
  await dbAdmin.insert(jobsTable).values({
    id: binding.jobId,
    tenantId: tenantA,
    status: "active",
    title: job.title,
    description: job.brief,
    clientWorkOrderNumber: job.externalId,
    isConfidential: false,
    interviewPath: "ai",
  });
  await dbAdmin.insert(candidatesTable).values([
    {
      id: binding.candidateId,
      tenantId: tenantA,
      pool: "tenant",
      email: input.candidate.email,
      firstName: "Taylor",
      lastName: "Example",
      hideFromCurrentEmployer: false,
      doNotContact: false,
    },
    {
      id: "fixture-other-candidate",
      tenantId: tenantB,
      pool: "tenant",
      email: input.candidate.email,
      firstName: "Other",
      lastName: "Example",
      hideFromCurrentEmployer: false,
      doNotContact: false,
    },
    {
      id: "fixture-unmatched-candidate",
      tenantId: tenantA,
      pool: "tenant",
      email: "unmatched@example.invalid",
      firstName: "Unmatched",
      lastName: "Example",
      hideFromCurrentEmployer: false,
      doNotContact: false,
    },
  ]);
  const questions = [{ id: "q1", text: "How do you handle an escalation?" }];
  await dbAdmin.insert(interviewPlansTable).values({
    id: binding.planId,
    tenantId: tenantA,
    jobId: binding.jobId,
    title: "Reviewed Plan",
    language: "en-US",
    interviewType: "behavioral",
    estimatedDurationMinutes: 15,
    questions,
  });

  let preparationCredits = 0;
  async function launch() {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createSessionRevocationGuard(async () => false),
      withTenantContext,
      createQorInterviewRouter({
        checkAllowed: async () => true,
        addCredit: async () => {
          preparationCredits++;
        },
        roomUrl: (sid) => `https://sandbox.example.invalid/interviews/${sid}/room`,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    return {
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        }),
      call: async (
        path: string,
        method: "POST" | "GET",
        token?: string,
        body?: unknown,
        key?: string,
      ) => {
        const response = await fetch(base + path, {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        // Test the decoded wire payload separately from the server's TS models.
        return {
          status: response.status,
          json: (await response.json()) as Record<string, any>,
          headers: response.headers,
        };
      },
    };
  }
  const server = await launch();
  const second = await launch();
  t.after(() => Promise.all([server.close(), second.close()]).then(() => {}));
  const collection = "/api/partner/v1/interview-requests";
  const post = (payload: unknown = input, key = "fixture-submit-1", token = firstKey) =>
    server.call(collection, "POST", token, payload, key);
  let requestId: string;
  let sessionId: string;
  let otherId: string;
  const poll = (token = firstKey) => server.call(`${collection}/${requestId}`, "GET", token);
  const review = (query?: Record<string, string>, token = reviewerA) =>
    server.call(
      `/api/partner-review/v1/interview-requests/${requestId}${query ? `?${new URLSearchParams(query)}` : ""}`,
      "GET",
      token,
    );
  const act = (action: unknown, target = server) =>
    target.call(
      `/api/partner-review/v1/interview-requests/${requestId}`,
      "POST",
      reviewerA,
      action,
    );

  await t.test(
    "machine scopes, exclusive bearer credential, strict payload and idempotency header",
    async () => {
      assert.equal((await server.call(collection, "POST", undefined, input)).status, 401);
      assert.equal((await post(input, "fixture-submit-1", reviewerA)).status, 401);
      assert.equal((await post(input, "fixture-submit-1", expiredKey)).status, 401);
      assert.equal((await post(input, "fixture-submit-1", readOnlyKey)).status, 403);
      assert.equal((await server.call(collection, "POST", firstKey, input)).status, 400);
      assert.equal((await post({ ...input, tenantId: tenantB })).status, 400);
      assert.equal((await post({ ...input, job: { ...job, unrecognized: true } })).status, 400);
      assert.equal((await post({ ...input, selectionRef: "invalid\u0000ref" })).status, 400);
      const {
        rows: [privileges],
      } = await pool.query(`SELECT
      has_table_privilege('lexy_app', 'qor_partner_credentials', 'SELECT') AS can_read_credentials,
      has_table_privilege('lexy_app', 'qor_interview_requests', 'UPDATE') AS can_update_requests`);
      assert.deepEqual(privileges, { can_read_credentials: false, can_update_requests: false });
    },
  );

  await t.test(
    "concurrent intake on two listeners, conflicts and no native side effects",
    async () => {
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? second : server).call(collection, "POST", firstKey, input, "fixture-submit-1"),
        ),
      );
      assert.equal(replies.filter((r) => r.status === 201).length, 1);
      assert.equal(replies.filter((r) => r.status === 200).length, 7);
      requestId = replies[0].json.requestId;
      assert.ok(replies.every((r) => r.json.requestId === requestId));
      assert.equal(replies[0].headers.get("location"), `${collection}/${requestId}`);
      assert.equal((await post({ ...input, selectionRef: "changed" })).status, 409);
      assert.equal((await post(input, "second-key-same-application")).status, 409);
      const [stored] = await dbAdmin.select().from(requests);
      assert.ok(!JSON.stringify(stored).includes(input.candidate.email));
      assert.equal((await dbAdmin.select().from(interviewSessionsTable)).length, 0);
      assert.equal(preparationCredits, 0);
      assert.deepEqual((await poll()).json, {
        requestId,
        externalApplicationId: input.externalApplicationId,
        invitation: { status: "not_sent", reportedAt: null },
        interview: { status: "awaiting_review", completedAt: null },
        reportStatus: "not_ready",
        report: null,
      });
    },
  );

  await t.test(
    "exact employer separation with identical external IDs; staff controls aren't callable by QOR",
    async () => {
      const reply = await post(input, "fixture-submit-1", otherKey);
      assert.equal(reply.status, 201);
      otherId = reply.json.requestId;
      assert.notEqual(otherId, requestId);
      assert.equal((await poll(otherKey)).status, 404);
      assert.equal((await poll(createOnlyKey)).status, 403);
      assert.equal((await poll(readOnlyKey)).status, 200);
      assert.equal((await server.call(`${collection}/${otherId}`, "GET", firstKey)).status, 404);
      assert.equal((await review(undefined, reviewerB)).status, 404);
      assert.equal((await review(undefined, recruiter)).status, 403);
      assert.equal((await review(undefined, firstKey)).status, 401);
      assert.equal(
        (await review({ ...binding, candidateId: "fixture-other-candidate" })).status,
        404,
      );
      assert.equal(
        (await review({ ...binding, candidateId: "fixture-unmatched-candidate" })).status,
        404,
      );
    },
  );

  await t.test(
    "reviewed preparation is atomic, freezes the plan, and replay only creates one native session",
    async () => {
      const first = await review(binding);
      assert.equal(first.status, 200);
      const staleAction = {
        ...binding,
        action: "prepare",
        reviewHash: first.json.preparation.reviewHash,
        confirm: true,
      };
      await dbAdmin
        .update(interviewPlansTable)
        .set({ title: "Changed review" })
        .where(eq(interviewPlansTable.id, binding.planId));
      assert.equal((await act(staleAction)).status, 409);
      const current = await review(binding);
      const prepare = { ...staleAction, reviewHash: current.json.preparation.reviewHash };
      assert.equal((await act({ ...prepare, confirm: false })).status, 400);
      const approvals = await Promise.all([act(prepare), act(prepare, second)]);
      assert.ok(approvals.every((r) => r.status === 200));
      const sessions = await dbAdmin.select().from(interviewSessionsTable);
      assert.equal(sessions.length, 1);
      assert.equal(preparationCredits, 1);
      const [session] = sessions;
      sessionId = session.id;
      assert.equal(session.tenantId, tenantA);
      assert.equal(session.applicationId, `qor-request:${requestId}`);
      assert.equal(session.inviteSentAt, null);
      await dbAdmin
        .update(interviewPlansTable)
        .set({ questions: [] })
        .where(eq(interviewPlansTable.id, binding.planId));
      const [copy] = await dbAdmin
        .select()
        .from(interviewPlansTable)
        .where(eq(interviewPlansTable.id, session.planId));
      assert.deepEqual(copy.questions, questions);
      assert.equal((await post()).status, 200);
      assert.equal((await poll()).json.interview.status, "prepared");
      assert.equal((await poll()).json.invitation.status, "not_sent");
    },
  );

  await t.test(
    "manual invitation evidence stays separate from native session progress",
    async () => {
      const { json } = await review();
      const approval = { reviewHash: json.invitation.reviewHash, confirm: true };
      assert.equal((await act({ action: "record_invitation_sent", ...approval })).status, 409);
      const released = await act({ action: "release_invitation", ...approval });
      assert.equal(released.status, 200);
      assert.ok(released.json.roomUrl.endsWith("/room"));
      const shareable = (await poll()).json;
      assert.equal(shareable.invitation.status, "ready_to_share");
      assert.ok(!JSON.stringify(shareable).includes(sessionId));
      assert.equal((await act({ action: "record_invitation_sent", ...approval })).status, 200);
      await dbAdmin
        .update(interviewSessionsTable)
        .set({ status: "active" })
        .where(eq(interviewSessionsTable.id, sessionId));
      const active = (await poll()).json;
      assert.equal(active.invitation.status, "staff_reported_sent");
      assert.equal(active.interview.status, "in_progress");
      await dbAdmin
        .update(interviewSessionsTable)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(interviewSessionsTable.id, sessionId));
      const complete = (await poll()).json;
      assert.equal(complete.interview.status, "completed");
      assert.equal(complete.reportStatus, "processing");
      assert.equal(complete.report, null);
    },
  );

  await t.test(
    "only exact session-bound QOR approval exposes allowlisted evidence; changes withdraw it",
    async () => {
      const content = {
        headline: "Synthetic report",
        executiveSummary: "Described escalation triage.",
        roleAlignment: "Synthetic alignment",
        competencies: [
          {
            key: "escalation",
            label: "Escalation",
            score: 75,
            evidence: "Prioritized severity and assigned ownership.",
            rationale: "Private rationale",
            insufficientEvidence: false,
          },
        ],
        behavioralInsights: [],
        developmentOpportunities: [],
        observations: [],
        riskAssessment: { concerns: [], toValidate: [] },
        assessmentQualityWarnings: ["No workforce planning evidence."],
        verification: { status: "not_available", summary: "Private verification." },
        recommendation: { band: "further_assessment", rationale: "Private recommendation." },
        evidenceBasis: {
          hasInterview: true,
          interviewAnswers: 1,
          hasIntelligence: false,
          hasResume: false,
          provenance: {
            kind: "job_bound_evaluation_v1",
            jobId: binding.jobId,
            candidateId: binding.candidateId,
            interviewSessionId: "wrong-session",
          },
        },
        transcript: "PRIVATE_TRANSCRIPT",
      };
      await dbAdmin.insert(interviewSummariesTable).values({
        id: "fixture-summary",
        interviewSessionId: sessionId,
        recruiterSummary: "Internal only.",
        overallScore: 77,
        recruiterComments: "PRIVATE_NOTES",
        transcript: ["PRIVATE_TRANSCRIPT"],
      });
      await dbAdmin.insert(candidateEvaluationsTable).values({
        id: "fixture-evaluation",
        tenantId: tenantA,
        jobId: binding.jobId,
        candidateId: binding.candidateId,
        aiContent: content,
        humanEdits: null,
        competencyKeys: ["escalation"],
        approvalState: "approved",
        approvedAt: new Date(),
      });
      assert.equal((await review()).json.reportReview.report, null);
      content.evidenceBasis.provenance.interviewSessionId = sessionId;
      await dbAdmin
        .update(candidateEvaluationsTable)
        .set({ aiContent: content })
        .where(eq(candidateEvaluationsTable.id, "fixture-evaluation"));
      const prior = (await poll()).json;
      assert.equal(prior.reportStatus, "awaiting_review");
      assert.equal(prior.report, null);
      const preview = (await review()).json.reportReview;
      assert.ok(preview.report);
      const approve = {
        action: "approve_report",
        reviewHash: preview.reviewHash,
        expectedVersion: preview.expectedVersion,
        confirm: true,
      };
      assert.equal((await act(approve)).status, 200);
      assert.equal((await act(approve, second)).status, 200);
      const approved = (await poll()).json;
      assert.equal(approved.reportStatus, "approved");
      assert.equal(approved.report.version, 1);
      const { version: _version, approvedAt: _approvedAt, ...returnedEvidence } = approved.report;
      assert.deepEqual(returnedEvidence, preview.report);
      assert.ok(!JSON.stringify(approved).includes("PRIVATE_"));
      await dbAdmin
        .update(candidateEvaluationsTable)
        .set({ approvalState: "draft" })
        .where(eq(candidateEvaluationsTable.id, "fixture-evaluation"));
      assert.equal((await poll()).json.reportStatus, "withdrawn");
      assert.equal((await poll()).json.report, null);
      await dbAdmin
        .update(candidateEvaluationsTable)
        .set({ approvalState: "approved" })
        .where(eq(candidateEvaluationsTable.id, "fixture-evaluation"));
      assert.equal((await act(approve)).status, 409);
      const refreshed = (await review()).json.reportReview;
      assert.equal(
        (
          await act({
            ...approve,
            reviewHash: refreshed.reviewHash,
            expectedVersion: refreshed.expectedVersion,
          })
        ).status,
        200,
      );
      assert.equal((await poll()).json.report.version, 2);
      assert.equal(
        (await act({ action: "withdraw_report", expectedVersion: 2, confirm: true })).status,
        200,
      );
      assert.equal((await poll()).json.reportStatus, "withdrawn");
      assert.equal(
        (await act({ ...approve, reviewHash: refreshed.reviewHash, expectedVersion: 2 })).status,
        409,
      );
    },
  );

  await t.test("revocation and erasure fail closed, including retry after scrub", async () => {
    const replayOnFreshRouter = await second.call(
      collection,
      "POST",
      firstKey,
      input,
      "fixture-submit-1",
    );
    assert.equal(replayOnFreshRouter.status, 200);
    assert.equal(replayOnFreshRouter.json.requestId, requestId);
    const pending = await post(
      { ...input, externalApplicationId: "qor-app-pending" },
      "fixture-pending-2",
    );
    assert.equal(pending.status, 201);
    await dbAdmin
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(eq(credentials.digest, qorDigest(otherKey)));
    assert.equal((await server.call(`${collection}/${otherId}`, "GET", otherKey)).status, 401);
    await dbAdmin
      .update(candidatesTable)
      .set({ doNotContact: true })
      .where(eq(candidatesTable.id, binding.candidateId));
    assert.equal((await poll()).status, 404);
    await dbAdmin.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM candidates WHERE id=${binding.candidateId} FOR UPDATE`);
      await scrubQorInterviewRequests(tx, binding.candidateId);
    });
    assert.equal((await poll()).status, 404);
    assert.equal((await post()).status, 404);
    assert.equal(
      (await server.call(`${collection}/${pending.json.requestId}`, "GET", firstKey)).status,
      404,
    );
    assert.equal(
      (await server.call(`${collection}/${otherId}`, "GET", await tokenFor(tenantB))).status,
      200,
    );
    const [scrubbed] = await dbAdmin.select().from(requests).where(eq(requests.id, requestId));
    assert.ok(scrubbed.erasedAt && scrubbed.idempotencyHash);
    assert.equal(scrubbed.sessionId, null);
    assert.equal(scrubbed.externalApplicationId, null);
    assert.equal(scrubbed.contactHash, null);
  });

  await t.test("the full API mounts QOR and safely rejects malformed intake", async () => {
    // Import the Express app, not the scheduler/worker startup entry point.
    // Match the production bundler's text loader for the existing guide pages.
    registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".html"))
          return {
            format: "module",
            shortCircuit: true,
            source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`,
          };
        return nextLoad(url, context);
      },
    });
    await pool.query(
      await readFile(
        new URL("../../../../lib/db/drizzle/0045_http_access_logs.sql", import.meta.url),
        "utf8",
      ),
    );
    const { default: app } = await import("../app");
    const fullServer = app.listen(0, "127.0.0.1");
    try {
      await once(fullServer, "listening");
      const address = fullServer.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}`;
      const health = await fetch(`${url}/api/healthz/live`);
      assert.equal(health.status, 200);
      const read = await fetch(`${url}${collection}/${otherId}`, {
        headers: { Authorization: `Bearer ${await tokenFor(tenantB)}` },
      });
      assert.equal(read.status, 200);
      const malformed = await fetch(`${url}${collection}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"candidate":"never@example.invalid",',
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), {
        code: "invalid_request",
        error: "Invalid or oversized request body.",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        fullServer.close((err) => (err ? reject(err) : resolve()));
        fullServer.closeAllConnections();
      });
    }
  });
});
