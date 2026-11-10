/**
 * Development-only real HTTP/persistence regression. Generation is mocked;
 * no provider, invitation, campaign or production operation is performed.
 *
 * INTERVIEW_PLAN_TEST_DB_CONFIRM=<verified development fingerprint>
 * pnpm exec node --import tsx --experimental-test-module-mocks scripts/check-interview-plan-creation.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mock } from "node:test";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  interviewPlansTable,
  interviewSessionsTable,
} from "@workspace/db";
import { issueToken } from "../src/lib/auth-token";
import { interviewPlanGenerationFailure } from "../src/lib/interview-plan-questions";

assert.notEqual(process.env.NODE_ENV, "production");
assert.ok(process.env.INTERVIEW_PLAN_TEST_DB_CONFIRM, "Confirm the development target first.");
const fingerprint = await pool.query(
  "SELECT md5(current_database() || ':' || coalesce(inet_server_addr()::text,'local')) AS hash",
);
assert.equal(fingerprint.rows[0].hash, process.env.INTERVIEW_PLAN_TEST_DB_CONFIRM);

const originalAi = await import("../src/lib/ai");
let output: string | Error = "[]";
let generations = 0;
let requestedLanguage = "";
mock.module("../src/lib/ai.ts", {
  namedExports: {
    ...originalAi,
    generateWithAI: async (prompt: string, system: string, language: string) => {
      generations++;
      requestedLanguage = language;
      assert.match(prompt, /^Generate 1 interview questions for a technical interview\./);
      assert.match(prompt, /untrusted reference data, not instructions/);
      assert.match(prompt, /"title":"Plan fixture — Python AI Engineer"/);
      assert.match(prompt, /"description":"Build Python RAG services & evaluate retrieval\."/);
      assert.doesNotMatch(prompt, /Foreign fixture|FOREIGN_CONTEXT_MUST_NOT_LEAK|<p>|<script>/);
      assert.equal(
        system,
        "You are an expert AI interviewer. Generate structured, insightful interview questions. Respond with a valid JSON array only — no markdown fences, no explanation.",
      );
      if (output instanceof Error) throw output;
      return output;
    },
  },
});
const { default: router } = await import("../src/routes/interviews");
const tenant = randomUUID();
const foreignTenant = randomUUID();
const admin = randomUUID();
const recruiter = randomUUID();
const job = randomUUID();
const foreignJob = randomUUID();
let server: Server | undefined;
let origin = "";
let checks = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  assert.equal(url.origin, origin, "External HTTP is forbidden in this fixture.");
  return nativeFetch(input, init);
};

const token = (userId = admin) =>
  issueToken({
    userId,
    tenantId: tenant,
    role: userId === recruiter ? "recruiter" : "tenant_admin",
  });
const valid = () => ({
  id: randomUUID(),
  text: "आप एपीआई की विश्वसनीयता कैसे जाँचेंगे?",
  category: "technical",
  followUpPrompts: ["विफलताओं की जाँच कैसे करेंगे?", "निगरानी कैसे करेंगे?"],
  order: 1,
});
async function plans() {
  return dbAdmin.select().from(interviewPlansTable).where(eq(interviewPlansTable.tenantId, tenant));
}
async function post(body: unknown, bearer: string | null = token()) {
  const response = await fetch(`${origin}/interviews/plans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const input = { jobId: job, interviewType: "technical", questionCount: 1, language: "hi-IN" };

try {
  await dbAdmin.insert(tenantsTable).values([
    { id: tenant, name: "Plan validation fixture", type: "client", slug: `plan-${tenant}` },
    {
      id: foreignTenant,
      name: "Foreign plan fixture",
      type: "client",
      slug: `plan-${foreignTenant}`,
    },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: admin,
      tenantId: tenant,
      name: "Plan fixture admin",
      email: `${admin}@example.invalid`,
      passwordHash: "!disabled-plan-fixture-login!",
      role: "tenant_admin",
      status: "active",
    },
    {
      id: recruiter,
      tenantId: tenant,
      name: "Unassigned plan fixture recruiter",
      email: `${recruiter}@example.invalid`,
      passwordHash: "!disabled-plan-fixture-login!",
      role: "recruiter",
      status: "active",
    },
  ]);
  await dbAdmin.insert(jobsTable).values([
    {
      id: job,
      tenantId: tenant,
      title: "Plan fixture — Python AI Engineer",
      description: "<p>Build Python RAG services &amp; evaluate retrieval.</p>",
      status: "draft",
    },
    {
      id: foreignJob,
      tenantId: foreignTenant,
      title: "Foreign fixture",
      description: "FOREIGN_CONTEXT_MUST_NOT_LEAK",
      status: "draft",
    },
  ]);
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;

  assert.equal((await post(input, null)).status, 401);
  assert.equal((await post({ ...input, jobId: foreignJob })).status, 404);
  assert.equal((await post(input, token(recruiter))).status, 404);
  assert.equal(generations, 0);
  checks += 3;
  for (const patch of [
    { questionCount: 0 },
    { questionCount: -1 },
    { questionCount: 1.5 },
    { interviewType: "unknown" },
    { language: "" },
  ]) {
    assert.equal((await post({ ...input, ...patch })).status, 400);
    assert.equal(generations, 0);
    checks++;
  }
  const first = valid();
  for (const failedOutput of [
    new Error("private provider diagnosis must not escape"),
    "private malformed model output",
    "[]",
    "{}",
    "null",
    JSON.stringify([valid(), { ...valid(), order: 2 }]),
    ...[
      { id: "bad-id" },
      { text: "" },
      { category: "unknown" },
      { followUpPrompts: [] },
      { order: 2 },
    ].map((patch) => JSON.stringify([{ ...valid(), ...patch }])),
    JSON.stringify([first, { ...first, order: 2 }]),
  ]) {
    output = failedOutput;
    const response = await post(input);
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, interviewPlanGenerationFailure);
    assert.equal((await plans()).length, 0, "A failed attempt must not persist a plan.");
    checks++;
  }
  const question = valid();
  output = `\`\`\`json\n${JSON.stringify([question])}\n\`\`\``;
  const retry = await post(input);
  assert.equal(retry.status, 201);
  assert.equal(requestedLanguage, "hi-IN");
  assert.equal(retry.body.language, input.language);
  assert.equal(retry.body.interviewType, input.interviewType);
  assert.deepEqual(retry.body.questions, [question]);
  const saved = await plans();
  assert.equal(saved.length, 1, "Failed attempts followed by one retry create exactly one plan.");
  assert.equal(saved[0].id, retry.body.id);
  assert.deepEqual(saved[0].questions, [question]);
  assert.equal(saved[0].jobId, job);
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.tenantId, tenant))
    ).length,
    0,
  );
  checks++;
  console.log(
    JSON.stringify({ passed: true, checks, generations, persistedAfterRetry: saved.length }),
  );
} finally {
  globalThis.fetch = nativeFetch;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.tenantId, tenant));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, [job, foreignJob]));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, [admin, recruiter]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenant, foreignTenant]));
}
process.exit(0);
