import assert from "node:assert/strict";
import { z } from "zod";
import { jsonObjectSchema, readJsonObject } from "../test-utils/json-response";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { runInNewContext } from "node:vm";
import express from "express";
import { inArray } from "drizzle-orm";
import * as tables from "@workspace/db";
import ts from "typescript";
import { issueToken } from "../lib/auth-token";
import { resolveCandidateId } from "../lib/portal-auth";
import { withTenantContext } from "../middlewares/withTenantContext";

const { dbAdmin } = tables;
const prefix = `export_${crypto.randomUUID().slice(0, 8)}_`;
const id = (suffix: string) => prefix + suffix;
const tenants = [id("tenant_a"), id("tenant_b")];
const candidates = ["a", "b", "c", "empty", "erased"].map((name) => id(name));
const users = [...candidates.map((candidate) => `${candidate}_user`), id("unlinked")];
const jobs = [id("job_a"), id("job_b")];
const applications = ["app_a", "app_b", "app_c"].map(id);
const schedules = ["schedule_a", "schedule_b", "schedule_c", "wrong_tenant"].map(id);
const sessionId = id("session");
const planId = id("plan");
let server: Server | undefined;
let baseUrl = "";
let failRead = false;

// Execute the current export controller over real disposable database records.
// Only dynamic table loading, audit/logging and the DB handle are substituted.
// dbAdmin intentionally removes RLS assistance: the SQL ownership predicates
// must themselves exclude other candidates and inconsistent child tenants.
const file = new URL("./career-profile.ts", import.meta.url);
const ast = ts.createSourceFile(
  file.pathname,
  readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const handlers: ts.Node[] = [];
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "router.get" &&
    ts.isStringLiteral(node.arguments[0]!) &&
    node.arguments[0].text === "/portal/me/export"
  )
    handlers.push(node.arguments.at(-1)!);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(handlers.length, 1);
let tableImports = 0;
const compiled = ts.transpileModule(`export const handler = ${handlers[0]!.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  transformers: {
    before: [
      (context) => {
        const replace: ts.Visitor = (node) => {
          if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            ts.isStringLiteral(node.arguments[0]!) &&
            node.arguments[0].text === "@workspace/db"
          ) {
            tableImports++;
            return context.factory.createIdentifier("dbTables");
          }
          return ts.visitEachChild(node, replace, context);
        };
        return (source) => ts.visitNode(source, replace) as ts.SourceFile;
      },
    ],
  },
}).outputText;
assert.equal(tableImports, 1);
const exports: { handler?: express.RequestHandler } = {};
runInNewContext(compiled, {
  exports,
  ...tables,
  dbTables: tables,
  db: {
    select: (...args: Parameters<typeof dbAdmin.select>) => {
      if (failRead) throw new Error("PRIVATE_DATABASE_FAILURE");
      return dbAdmin.select(...args);
    },
  },
  getCandidateId: resolveCandidateId,
  eq: (await import("drizzle-orm")).eq,
  and: (await import("drizzle-orm")).and,
  inArray,
  classBRead: () => {},
  CLASS_B_READ_EXEMPTION: { CANDIDATE_SELF_OWNED: "self" },
  recordAudit: async () => {},
  logger: { error: () => {} },
});

async function cleanup() {
  await dbAdmin
    .delete(tables.interviewSchedulesTable)
    .where(inArray(tables.interviewSchedulesTable.id, schedules));
  await dbAdmin
    .delete(tables.interviewSessionsTable)
    .where(inArray(tables.interviewSessionsTable.id, [sessionId]));
  await dbAdmin
    .delete(tables.interviewPlansTable)
    .where(inArray(tables.interviewPlansTable.id, [planId]));
  await dbAdmin
    .delete(tables.applicationsTable)
    .where(inArray(tables.applicationsTable.id, applications));
  await dbAdmin.delete(tables.jobsTable).where(inArray(tables.jobsTable.id, jobs));
  await dbAdmin
    .delete(tables.candidatesTable)
    .where(inArray(tables.candidatesTable.id, candidates));
  await dbAdmin.delete(tables.usersTable).where(inArray(tables.usersTable.id, users));
  await dbAdmin.delete(tables.tenantsTable).where(inArray(tables.tenantsTable.id, tenants));
}

before(async () => {
  await dbAdmin.insert(tables.tenantsTable).values(
    tenants.map((tenant, index) => ({
      id: tenant,
      name: `Export Fixture ${index}`,
      slug: tenant,
      plan: "enterprise" as const,
    })),
  );
  await dbAdmin.insert(tables.usersTable).values(
    users.map((user, index) => ({
      id: user,
      tenantId: tenants[index === 2 ? 1 : 0]!,
      email: `${user}@test.invalid`,
      name: "Export Fixture",
      passwordHash: "x",
      role: "candidate" as const,
    })),
  );
  await dbAdmin.insert(tables.candidatesTable).values(
    candidates.map((candidate, index) => ({
      id: candidate,
      userId: users[index]!,
      tenantId: tenants[index === 2 ? 1 : 0]!,
      firstName: "Export",
      lastName: "Fixture",
      email: `${candidate}@test.invalid`,
      pool: "tenant" as const,
      dataErasedAt: index === 4 ? new Date() : null,
    })),
  );
  await dbAdmin.insert(tables.jobsTable).values(
    jobs.map((job, index) => ({
      id: job,
      tenantId: tenants[index]!,
      title: "Private export fixture",
      description: "Not a real role",
    })),
  );
  await dbAdmin.insert(tables.applicationsTable).values(
    applications.map((application, index) => ({
      id: application,
      candidateId: candidates[index]!,
      tenantId: tenants[index === 2 ? 1 : 0]!,
      jobId: jobs[index === 2 ? 1 : 0]!,
      notes: "PRIVATE_APPLICATION_NOTE",
    })),
  );
  await dbAdmin.insert(tables.interviewPlansTable).values({
    id: planId,
    tenantId: tenants[0]!,
    jobId: jobs[0]!,
    title: "Private export fixture",
  });
  await dbAdmin.insert(tables.interviewSchedulesTable).values(
    schedules.map((schedule, index) => ({
      id: schedule,
      applicationId: applications[index === 3 ? 0 : index]!,
      tenantId: tenants[index >= 2 ? 1 : 0]!,
      type: "human",
      scheduledAt: new Date(),
      notes: "PRIVATE_SCHEDULE_NOTE",
      feedbackRating: 5,
      feedbackNotes: "PRIVATE_SCHEDULE_FEEDBACK",
    })),
  );
  const app = express();
  app.use(withTenantContext);
  app.get("/portal/me/export", exports.handler!);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await cleanup();
});

async function request(index?: number, query = "") {
  const auth =
    index === undefined
      ? undefined
      : issueToken({
          userId: users[index]!,
          role: "candidate",
          tenantId: tenants[index === 2 ? 1 : 0]!,
        });
  const response = await fetch(`${baseUrl}/portal/me/export${query}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await readJsonObject(response),
  };
}

const exportedBodySchema = z
  .object({
    candidateId: z.string(),
    applications: z.array(jsonObjectSchema),
    interviewSessions: z.array(jsonObjectSchema),
    interviewSchedules: z.array(z.object({ id: z.string() }).passthrough()),
  })
  .passthrough();

async function exported(index: number, query = "") {
  const result = await request(index, query);
  assert.equal(result.status, 200);
  return { ...result, body: exportedBodySchema.parse(result.body) };
}

test("manual schedules export without a session, with private feedback withheld and attachment headers", async () => {
  const result = await exported(0);
  assert.equal(result.status, 200);
  assert.equal(result.body.candidateId, candidates[0]);
  assert.deepEqual(result.body.interviewSessions, []);
  assert.deepEqual(
    result.body.interviewSchedules.map((row: { id: string }) => row.id),
    [schedules[0]],
  );
  assert.equal(result.body.interviewSchedules[0].feedbackRating, null);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.match(
    result.headers.get("content-disposition")!,
    /^attachment; filename="lexy-data-export-/,
  );
  assert.match(result.headers.get("content-type")!, /application\/json/);
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /PRIVATE_(APPLICATION_NOTE|SCHEDULE_NOTE|SCHEDULE_FEEDBACK)/,
  );
});

test("same-tenant and foreign candidates each get their own schedules, never the inconsistent child", async () => {
  for (const index of [1, 2]) {
    const result = await exported(index);
    assert.equal(result.status, 200);
    assert.equal(result.body.candidateId, candidates[index]);
    assert.deepEqual(
      result.body.interviewSchedules.map((row: { id: string }) => row.id),
      [schedules[index]],
    );
  }
  const forged = await exported(
    0,
    `?candidateId=${candidates[2]}&applicationId=${applications[2]}`,
  );
  assert.equal(forged.body.candidateId, candidates[0]);
  assert.deepEqual(
    forged.body.interviewSchedules.map((row: { id: string }) => row.id),
    [schedules[0]],
  );
});

test("recorded sessions preserve the candidate's answer, without hiring grades or binding secrets", async () => {
  await dbAdmin.insert(tables.interviewSessionsTable).values({
    id: sessionId,
    tenantId: tenants[0]!,
    candidateId: candidates[0]!,
    applicationId: applications[0]!,
    planId,
    score: 99,
    answers: [{ answer: "My own words", score: 99, feedback: "PRIVATE_SESSION_FEEDBACK" }],
    bindSecret: "PRIVATE_BIND_SECRET",
  });
  const result = await exported(0);
  assert.equal(result.status, 200);
  assert.equal(result.body.interviewSessions.length, 1);
  assert.deepEqual(result.body.interviewSessions[0].answers, [{ answer: "My own words" }]);
  assert.equal(result.body.interviewSessions[0].score, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_(SESSION_FEEDBACK|BIND_SECRET)/);
});

test("empty exports succeed, while tokenless, unlinked and erased candidates are denied", async () => {
  const empty = await exported(3);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.applications, []);
  assert.deepEqual(empty.body.interviewSchedules, []);
  assert.equal((await request()).status, 401);
  assert.equal((await request(5)).status, 401);
  // Erased profiles no longer resolve to a portal identity. Preserve the
  // public authentication boundary rather than exposing an erased identity.
  const erased = await request(4);
  const anonymous = await request();
  assert.equal(erased.status, 401);
  assert.deepEqual(erased.body, anonymous.body);
});

test("database failure never sends a partial download or discloses internal error details", async () => {
  failRead = true;
  try {
    const result = await request(0);
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: "Export failed" });
    assert.equal(result.headers.get("content-disposition"), null);
  } finally {
    failRead = false;
  }
});
