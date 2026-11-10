/**
 * Real HTTP/DB checks for the six legacy job-pipeline controls. Unique disposable
 * fixtures, no withTenantContext bypass assumptions, no agent/provider execution.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { dbAdmin, jobsTable, jobPipelinesTable, tenantsTable, usersTable } from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import agentsRouter from "./agents";

const prefix = `agent_access_${randomUUID().slice(0, 8)}_`;
const id = (name: string) => prefix + name;
const tenants = ["a", "b"].map(id);
const roles = {
  admin: "tenant_admin",
  recruiter: "recruiter",
  manager: "hiring_manager",
  candidate: "candidate",
  platform: "platform_admin",
} as const;
const users = Object.keys(roles).map(id);
const jobs = ["assigned", "unassigned", "foreign"].map(id);
let server: Server | undefined;
let origin: string;
function token(name: keyof typeof roles | "missing") {
  return issueToken({
    userId: id(name),
    role: name === "missing" ? "tenant_admin" : roles[name],
    tenantId: id("a"),
  });
}
async function pipeline(job: string) {
  return dbAdmin
    .select()
    .from(jobPipelinesTable)
    .where(eq(jobPipelinesTable.jobId, id(job)));
}
async function cleanup() {
  await dbAdmin.delete(jobPipelinesTable).where(inArray(jobPipelinesTable.jobId, jobs));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, jobs));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, users));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, tenants));
}
before(async () => {
  await dbAdmin.insert(tenantsTable).values(
    tenants.map((tenant) => ({
      id: tenant,
      name: "Synthetic access fixture",
      slug: tenant,
      plan: "enterprise" as const,
    })),
  );
  await dbAdmin.insert(usersTable).values(
    Object.entries(roles).map(([name, role]) => ({
      id: id(name),
      tenantId: id("a"),
      email: `${id(name)}@example.invalid`,
      name: "Synthetic access reviewer",
      role,
      passwordHash: "not-a-login-password",
    })),
  );
  await dbAdmin.insert(jobsTable).values(
    ["assigned", "unassigned", "foreign"].map((name) => ({
      id: id(name),
      tenantId: id(name === "foreign" ? "b" : "a"),
      title: "Synthetic access role",
      description: "Isolated access test.",
      status: "active" as const,
      assignedRecruiterId: name === "assigned" ? id("recruiter") : null,
    })),
  );
  await dbAdmin.insert(jobPipelinesTable).values(
    ["assigned", "unassigned", "foreign"].map((name) => ({
      jobId: id(name),
      tenantId: id(name === "foreign" ? "b" : "a"),
      agents: ["screening"],
      autoRun: false,
      interviewDirection: { general: { focusDirective: `Synthetic ${name} direction.` } },
    })),
  );
  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      assert.ok(address && typeof address !== "string");
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await cleanup();
});
const routes = [
  { method: "GET", suffix: "pipeline-config" },
  {
    method: "POST",
    suffix: "pipeline-config",
    body: { agentIds: ["screening"], autoRun: false, targetCandidates: 7 },
  },
  { method: "GET", suffix: "interview-direction" },
  {
    method: "POST",
    suffix: "interview-direction",
    body: { type: "general", focusDirective: "Synthetic revised direction.", customQuestions: [] },
  },
  { method: "GET", suffix: "pipeline-status" },
  { method: "POST", suffix: "pipeline-stop", body: {} },
];
async function request(route: (typeof routes)[number], job = "assigned", auth?: string) {
  const response = await fetch(`${origin}/jobs/${id(job)}/${route.suffix}`, {
    method: route.method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(route.method === "POST" ? { body: JSON.stringify(route.body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
for (const route of routes) {
  const label = `${route.method} ${route.suffix}`;
  test(`${label}: no identity or missing account is 401; candidate role is 403`, async () => {
    const beforeRow = await pipeline("assigned");
    assert.equal((await request(route)).status, 401);
    assert.equal((await request(route, "assigned", token("missing"))).status, 401);
    assert.equal((await request(route, "assigned", token("candidate"))).status, 403);
    assert.deepEqual(await pipeline("assigned"), beforeRow);
  });
  test(`${label}: foreign and missing jobs share 404 and do not change foreign state`, async () => {
    const beforeRow = await pipeline("foreign");
    const foreign = await request(route, "foreign", token("admin"));
    const missing = await request(route, "missing", token("admin"));
    assert.deepEqual(foreign, { status: 404, body: { error: "Not found" } });
    assert.deepEqual(missing, foreign);
    assert.deepEqual(await pipeline("foreign"), beforeRow);
  });
  test(`${label}: same-tenant unassigned recruiter is denied without mutation`, async () => {
    const beforeRow = await pipeline("unassigned");
    assert.deepEqual(await request(route, "unassigned", token("recruiter")), {
      status: 404,
      body: { error: "Not found" },
    });
    assert.deepEqual(await pipeline("unassigned"), beforeRow);
  });
  test(`${label}: assigned recruiter and scoped tenant administrator remain supported`, async () => {
    assert.equal((await request(route, "assigned", token("recruiter"))).status, 200);
    assert.equal((await request(route, "unassigned", token("admin"))).status, 200);
  });
  test(`${label}: platform-wide scope is retained; hiring manager can read but not configure`, async () => {
    assert.equal((await request(route, "foreign", token("platform"))).status, 200);
    const beforeRow = await pipeline("assigned");
    assert.equal(
      (await request(route, "assigned", token("manager"))).status,
      route.method === "GET" ? 200 : 403,
    );
    assert.deepEqual(await pipeline("assigned"), beforeRow);
  });
}
test("authorized manual pipeline configuration, direction and stop persist without dispatching agents", async () => {
  assert.equal((await request(routes[1], "assigned", token("recruiter"))).status, 200);
  assert.equal((await request(routes[3], "assigned", token("recruiter"))).status, 200);
  const [saved] = await pipeline("assigned");
  assert.deepEqual(saved.agents, ["screening"]);
  assert.equal(saved.targetCandidates, 7);
  assert.equal(saved.autoRun, false);
  assert.deepEqual(saved.interviewDirection, {
    general: { focusDirective: "Synthetic revised direction.", customQuestions: [] },
  });
  assert.equal((await request(routes[5], "assigned", token("recruiter"))).status, 200);
  const [stopped] = await pipeline("assigned");
  assert.equal(stopped.status, "idle");
  assert.equal(stopped.autoRun, false);
});
