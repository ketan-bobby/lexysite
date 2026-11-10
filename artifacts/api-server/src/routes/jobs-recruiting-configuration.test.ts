import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readJsonObject } from "../test-utils/json-response";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  jobRecruitersTable,
  recruiterAdminClientsTable,
  candidatesTable,
  applicationsTable,
  auditLogsTable,
} from "@workspace/db";
import jobsRouter from "./jobs";
import { issueToken } from "../lib/auth-token";
import { orchestrator } from "../lib/agents/orchestrator";

const prefix = `recruiting_${randomUUID()}`;
const tenant = `${prefix}_agency`;
const client = `${prefix}_client`;
const foreign = `${prefix}_foreign`;
const jobId = `${prefix}_job`;
const candidateId = `${prefix}_candidate`;
const applicationId = `${prefix}_application`;
const ids = (name: string) => `${prefix}_${name}`;
const roles = {
  admin: "tenant_admin",
  platform: "platform_admin",
  manager: "recruiter_admin",
  unmanaged: "recruiter_admin",
  recruiter: "recruiter",
  joined: "recruiter",
  peer: "recruiter",
  hm: "hiring_manager",
  hmPeer: "hiring_manager",
  candidate: "candidate",
  interviewer: "interviewer",
  foreign: "tenant_admin",
} as const;
type Actor = keyof typeof roles;
const token = (actor: Actor) =>
  issueToken({
    userId: ids(actor),
    role: roles[actor],
    tenantId: actor === "foreign" ? foreign : tenant,
  });
let server: Server;
let base: string;
const agentSpy = mock.method(orchestrator, "triggerAgent", async () => {
  throw new Error("Configuration-only tests must not execute agents");
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  actor: Actor | null = "admin",
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(actor ? { Authorization: `Bearer ${token(actor)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await readJsonObject(response) };
}

const save = (body: unknown, actor: Actor | null = "admin", id = jobId) =>
  request("PATCH", `/jobs/${id}/recruiting-configuration`, body, actor);

async function sideEffects() {
  const result = await dbAdmin.execute(sql`
    SELECT
      (SELECT count(*) FROM ai_jobs WHERE tenant_id IN (${tenant}, ${client})) AS queued,
      (SELECT count(*) FROM pipeline_runs WHERE tenant_id IN (${tenant}, ${client})) AS runs,
      (SELECT count(*) FROM interview_sessions WHERE tenant_id IN (${tenant}, ${client})) AS interviews,
      (SELECT count(*) FROM outreach_messages WHERE tenant_id IN (${tenant}, ${client})) AS messages,
      (SELECT count(*) FROM credit_usage_events WHERE tenant_id IN (${tenant}, ${client})) AS credits
  `);
  const [application] = await dbAdmin
    .select({ stage: applicationsTable.stage })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));
  const [job] = await dbAdmin
    .select({
      status: jobsTable.status,
      internalMobility: jobsTable.internalMobility,
      description: jobsTable.description,
    })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  return { ...result.rows[0], application, job, agentCalls: agentSpy.mock.callCount() };
}

before(async () => {
  await dbAdmin.insert(tenantsTable).values([
    { id: tenant, name: "Configuration agency", slug: tenant },
    { id: client, parentId: tenant, name: "Configuration client", slug: client },
    { id: foreign, name: "Foreign configuration tenant", slug: foreign },
  ]);
  await dbAdmin.insert(usersTable).values(
    Object.entries(roles).map(([name, role]) => ({
      id: ids(name),
      tenantId: name === "foreign" ? foreign : tenant,
      email: `${ids(name)}@example.invalid`,
      name: `Configuration ${name}`,
      passwordHash: "unused-fixture-password",
      role,
      status: "active" as const,
    })),
  );
  await dbAdmin.insert(recruiterAdminClientsTable).values({
    tenantId: tenant,
    recruiterAdminUserId: ids("manager"),
    clientTenantId: client,
    assignedByUserId: ids("admin"),
  });
  // Omitted config fields exercise DB defaults on a legacy-style requisition.
  await dbAdmin.insert(jobsTable).values({
    id: jobId,
    tenantId: client,
    title: "Legacy-style requisition",
    description:
      "A substantial existing description that must NOT regenerate ICP when settings change.",
    assignedRecruiterId: ids("recruiter"),
    assignedHiringManagerId: ids("hm"),
    internalMobility: true,
    status: "paused",
  });
  await dbAdmin.insert(jobRecruitersTable).values({
    jobId,
    tenantId: client,
    recruiterUserId: ids("joined"),
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId: client,
    firstName: "Fixture",
    lastName: "Candidate",
    email: `${candidateId}@example.invalid`,
    pool: "tenant",
  });
  await dbAdmin.insert(applicationsTable).values({
    id: applicationId,
    tenantId: client,
    jobId,
    candidateId,
    stage: "applied",
  });
  const app = express();
  app.use(express.json());
  app.use(jobsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const tenants = [tenant, client, foreign];
  await dbAdmin.delete(auditLogsTable).where(inArray(auditLogsTable.tenantId, tenants));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.tenantId, tenants));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, tenants));
  await dbAdmin.delete(jobRecruitersTable).where(inArray(jobRecruitersTable.tenantId, tenants));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, tenants));
  await dbAdmin
    .delete(recruiterAdminClientsTable)
    .where(eq(recruiterAdminClientsTable.clientTenantId, client));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, tenants));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, tenants));
  agentSpy.mock.restore();
});

test("legacy defaults stay Human Assisted with human review and execution disabled", async () => {
  const result = await request("GET", `/jobs/${jobId}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.recruitingMode, "human_assisted");
  assert.equal(result.body.interviewPath, "recruiter_choice");
  assert.equal(result.body.autonomyExecutionEnabled, false);
  assert.equal(result.body.progressionAuthority, "human_review");
});

for (const recruitingMode of ["human_assisted", "lexy_autonomous"]) {
  for (const interviewPath of [
    "ai",
    "human",
    "ai_then_human",
    "human_then_ai",
    "recruiter_choice",
  ]) {
    test(`configuration round-trips ${recruitingMode}/${interviewPath} without side effects`, async () => {
      const before = await sideEffects();
      const saved = await save({ recruitingMode, interviewPath });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const reloaded = await request("GET", `/jobs/${jobId}`);
      assert.equal(reloaded.body.recruitingMode, recruitingMode);
      assert.equal(reloaded.body.interviewPath, interviewPath);
      assert.equal(reloaded.body.autonomyExecutionEnabled, false);
      assert.equal(reloaded.body.progressionAuthority, "human_review");
      const [stored] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId));
      assert.equal(stored.recruitingMode, recruitingMode);
      assert.equal(stored.interviewPath, interviewPath);
      assert.deepEqual(await sideEffects(), before);
    });
  }
}

for (const actor of ["platform", "manager", "recruiter", "joined", "hm"] as const) {
  test(`${actor} can save an authorized requisition`, async () => {
    const saved = await save({ interviewPath: "human" }, actor);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });
}

for (const actor of ["foreign", "peer", "unmanaged", "hmPeer"] as const) {
  test(`${actor} cannot save an out-of-scope requisition`, async () => {
    const before = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    assert.equal((await save({ interviewPath: "ai" }, actor)).status, 404);
    assert.deepEqual(await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId)), before);
  });
}

for (const actor of ["candidate", "interviewer"] as const) {
  test(`${actor} cannot configure recruiting or set create-time preferences`, async () => {
    assert.equal((await save({ interviewPath: "ai" }, actor)).status, 403);
    const created = await request(
      "POST",
      "/jobs",
      {
        title: "Forbidden configuration",
        description: "Short fixture",
        recruitingMode: "lexy_autonomous",
      },
      actor,
    );
    assert.equal(created.status, 403);
  });
}

test("anonymous and nonexistent job writes fail closed", async () => {
  assert.equal((await save({ recruitingMode: "lexy_autonomous" }, null)).status, 401);
  assert.equal((await save({ interviewPath: "ai" }, "admin", ids("missing"))).status, 404);
});

test("interviewer retains ordinary assisted creation without new configuration authority", async () => {
  const created = await request(
    "POST",
    "/jobs",
    { title: "Existing assisted permission", description: "Short fixture" },
    "interviewer",
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.recruitingMode, "human_assisted");
  assert.equal(created.body.interviewPath, "recruiter_choice");
  assert.equal(created.body.autonomyExecutionEnabled, false);
});

test("invalid values and execution/ownership flags are rejected atomically", async () => {
  const before = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  for (const body of [
    {},
    { recruitingMode: "autonomous" },
    { interviewPath: "technical" },
    { recruitingMode: null },
    { interviewPath: 1 },
    { recruitingMode: "human_assisted", interviewPath: "bad" },
    { recruitingMode: "lexy_autonomous", autonomyExecutionEnabled: true },
    { interviewPath: "ai", progressionAuthority: "automatic" },
    { interviewPath: "ai", tenantId: foreign },
    { interviewPath: "human", description: "Must not overwrite" },
  ]) {
    assert.equal((await save(body)).status, 400, JSON.stringify(body));
    assert.deepEqual(await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId)), before);
  }
});

test("partial configuration and unrelated ordinary edits preserve the other setting", async () => {
  await save({ recruitingMode: "lexy_autonomous", interviewPath: "ai_then_human" });
  await save({ interviewPath: "human_then_ai" });
  const edited = await request("PUT", `/jobs/${jobId}`, { department: "Engineering" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.recruitingMode, "lexy_autonomous");
  assert.equal(edited.body.interviewPath, "human_then_ai");
});

test("configuration saves record a tenant-scoped audit without granting authority", async () => {
  await save({ recruitingMode: "human_assisted", interviewPath: "ai" });
  const records = await dbAdmin
    .select()
    .from(auditLogsTable)
    .where(eq(auditLogsTable.subjectId, jobId));
  assert.ok(records.length > 0);
  assert.ok(records.every((row) => row.tenantId === client));
  assert.ok(records.every((row) => row.action === "job.recruiting_configuration.updated"));
  assert.ok(records.every((row) => (row.metadata as any)?.autonomyExecutionEnabled === false));
});

test("create-time preferences and default creation persist without extra autonomous work", async () => {
  for (const configured of [false, true]) {
    const before = await sideEffects();
    const created = await request("POST", "/jobs", {
      title: "Configuration create fixture",
      description: "Short fixture",
      ...(configured ? { recruitingMode: "lexy_autonomous", interviewPath: "human_then_ai" } : {}),
      autonomyExecutionEnabled: true,
      progressionAuthority: "automatic",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const reloaded = await request("GET", `/jobs/${created.body.id}`);
    assert.equal(reloaded.body.recruitingMode, configured ? "lexy_autonomous" : "human_assisted");
    assert.equal(reloaded.body.interviewPath, configured ? "human_then_ai" : "recruiter_choice");
    assert.equal(reloaded.body.autonomyExecutionEnabled, false);
    assert.equal(reloaded.body.progressionAuthority, "human_review");
    assert.deepEqual(await sideEffects(), before);
  }
});
