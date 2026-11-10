import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  jobsTable,
  applicationsTable,
  candidateDemographicsTable,
  candidateEventsTable,
  aiDecisionLogTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import analyticsRouter from "./analytics";

// Bare router deliberately omits tenant RLS: authorization must be enforced
// by the real HTTP handlers even when the underlying reader can see all rows.
const prefix = `caa_${crypto.randomUUID().slice(0, 8)}_`;
const id = (value: string) => prefix + value;
const tenantIds = ["own", "child", "foreign", "small"].map(id);
const jobIds = ["own", "unassigned", "child", "foreign", "small"].map(id);
const users = [
  { key: "admin", role: "tenant_admin", tenant: "own" },
  { key: "foreignAdmin", role: "tenant_admin", tenant: "foreign" },
  { key: "smallAdmin", role: "tenant_admin", tenant: "small" },
  { key: "candidate", role: "candidate", tenant: "own" },
  { key: "recruiter", role: "recruiter", tenant: "own" },
  { key: "manager", role: "hiring_manager", tenant: "own" },
  { key: "recruiterAdmin", role: "recruiter_admin", tenant: "own" },
  { key: "platform", role: "platform_admin", tenant: "own" },
] as const;
const records = [
  ...["own", "unassigned", "child", "foreign"].flatMap((job) =>
    Array.from({ length: 5 }, (_, n) => ({
      key: `${job}_${n}`,
      job,
      tenant: job === "unassigned" ? "own" : job,
    })),
  ),
  { key: "small_0", job: "small", tenant: "small" },
  { key: "dnc", job: "own", tenant: "own" },
  { key: "erased", job: "own", tenant: "own" },
];
const candidateIds = records.map((record) => id(record.key));
let server: Server;
let base: string;
function token(key: (typeof users)[number]["key"]) {
  const user = users.find((entry) => entry.key === key)!;
  return issueToken({ userId: id(key), role: user.role, tenantId: id(user.tenant) });
}
function request(path: string, key?: (typeof users)[number]["key"]) {
  return fetch(base + path, {
    headers: key ? { authorization: `Bearer ${token(key)}` } : {},
  });
}
async function cleanup() {
  await dbAdmin
    .delete(candidateEventsTable)
    .where(inArray(candidateEventsTable.candidateId, candidateIds));
  await dbAdmin.delete(aiDecisionLogTable).where(inArray(aiDecisionLogTable.jobId, jobIds));
  await dbAdmin
    .delete(candidateDemographicsTable)
    .where(inArray(candidateDemographicsTable.candidateId, candidateIds));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.jobId, jobIds));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, candidateIds));
  await dbAdmin.delete(usersTable).where(
    inArray(
      usersTable.id,
      users.map((user) => id(user.key)),
    ),
  );
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
}
before(async () => {
  await dbAdmin.insert(tenantsTable).values([
    { id: id("own"), name: "Analytics own", slug: id("own"), plan: "enterprise" },
    {
      id: id("child"),
      name: "Analytics child",
      slug: id("child"),
      parentId: id("own"),
      clientType: "sub_client",
      plan: "enterprise",
    },
    { id: id("foreign"), name: "Analytics foreign", slug: id("foreign"), plan: "enterprise" },
    { id: id("small"), name: "Analytics small", slug: id("small"), plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values(
    users.map((user) => ({
      id: id(user.key),
      tenantId: id(user.tenant),
      role: user.role,
      status: "active" as const,
      name: user.key,
      email: `${id(user.key)}@example.test`,
      passwordHash: "unused",
    })),
  );
  await dbAdmin.insert(jobsTable).values(
    ["own", "unassigned", "child", "foreign", "small"].map((key) => ({
      id: id(key),
      tenantId: id(key === "unassigned" ? "own" : key),
      title: `Analytics ${key}`,
      description: "Isolated analytics fixture",
      aedtEnabled: true,
      assignedRecruiterId: key === "own" ? id("recruiter") : null,
    })),
  );
  await dbAdmin.insert(candidatesTable).values(
    records.map((record) => ({
      id: id(record.key),
      tenantId: id(record.tenant),
      firstName: "Scope",
      lastName: record.key,
      email: `${id(record.key)}@example.test`,
      pool: "tenant" as const,
      source: id(record.job),
      currentTitle: "Engineer",
    })),
  );
  await dbAdmin.insert(applicationsTable).values(
    records.map((record) => ({
      id: id(`app_${record.key}`),
      tenantId: id(record.tenant),
      jobId: id(record.job),
      candidateId: id(record.key),
      stage: "applied" as const,
      entryType: "applied" as const,
    })),
  );
  await dbAdmin.insert(candidateDemographicsTable).values(
    records.map((record) => ({
      id: id(`demo_${record.key}`),
      candidateId: id(record.key),
      region: "us",
      consentVersion: "test",
      gender: "female",
    })),
  );
  await dbAdmin.insert(aiDecisionLogTable).values(
    records.map((record) => ({
      id: id(`decision_${record.key}`),
      tenantId: id(record.tenant),
      jobId: id(record.job),
      candidateId: id(record.key),
      decisionType: "shortlist",
      label: "review",
      score: 70,
    })),
  );
  // Deliberately inconsistent child records must not borrow a local tenant
  // label to expose a foreign job or a foreign application's final stage.
  await dbAdmin.insert(aiDecisionLogTable).values({
    id: id("foreignJobDecision"),
    tenantId: id("own"),
    jobId: id("foreign"),
    candidateId: id("foreign_0"),
    decisionType: "shortlist",
    label: "FOREIGN_JOB_SENTINEL",
  });
  await dbAdmin.insert(applicationsTable).values([
    {
      id: id("foreignJobApp"),
      tenantId: id("own"),
      jobId: id("foreign"),
      candidateId: id("foreign_0"),
      stage: "hired",
      entryType: "applied",
    },
    {
      id: id("foreignStageApp"),
      tenantId: id("foreign"),
      jobId: id("own"),
      candidateId: id("own_0"),
      stage: "hired",
      entryType: "applied",
    },
  ]);
  await dbAdmin.insert(candidateEventsTable).values([
    {
      eventId: id("ownEvent"),
      tenantId: id("own"),
      candidateId: id("own_0"),
      jobId: id("own"),
      eventType: "HIRED",
    },
    {
      eventId: id("foreignEvent"),
      tenantId: id("foreign"),
      candidateId: id("own_1"),
      jobId: id("own"),
      eventType: "HIRED",
    },
  ]);
  // Mark only after creating historical artifacts. Never clear an erasure
  // marker to restore a fixture; teardown deletes these disposable rows.
  await dbAdmin
    .update(candidatesTable)
    .set({ doNotContact: true })
    .where(eq(candidatesTable.id, id("dnc")));
  await dbAdmin
    .update(candidatesTable)
    .set({ dataErasedAt: new Date() })
    .where(eq(candidatesTable.id, id("erased")));
  const app = express();
  app.use(analyticsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

const diversity = z.object({
  total: z.number(),
  gender: z.array(z.object({ label: z.string(), count: z.number() })),
  bySource: z.array(z.object({ source: z.string() })),
});
test("all compliance surfaces deny anonymous callers and candidates", async () => {
  for (const path of [
    "/analytics/diversity",
    "/analytics/adverse-impact",
    "/analytics/aedt-export",
  ]) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, "candidate")).status, 403, path);
    const staleAdminClaim = issueToken({
      userId: id("candidate"),
      role: "platform_admin",
      tenantId: id("own"),
    });
    const stale = await fetch(base + path, {
      headers: { authorization: `Bearer ${staleAdminClaim}` },
    });
    assert.equal(stale.status, 403, "current database role overrides privileged token claim");
  }
});
test("raw demographics and adverse-impact remain admin-only", async () => {
  for (const key of ["recruiter", "recruiterAdmin", "manager"] as const) {
    for (const path of ["/analytics/adverse-impact", "/analytics/aedt-export"]) {
      assert.equal((await request(path, key)).status, 403);
    }
  }
});
test("diversity includes own subtree only, excludes barred rows and never serializes candidate IDs", async () => {
  const response = await request("/analytics/diversity", "admin");
  assert.equal(response.status, 200);
  const raw: unknown = await response.json();
  const data = diversity.parse(raw);
  assert.equal(data.total, 15);
  assert.deepEqual(data.gender, [{ label: "female", count: 15 }]);
  assert.deepEqual(
    new Set(data.bySource.map((row) => row.source)),
    new Set(["own", "unassigned", "child"].map(id)),
  );
  assert.equal(JSON.stringify(raw).includes(id("own_0")), false);
  assert.equal(JSON.stringify(raw).includes(id("foreign")), false);
  const foreign = await request("/analytics/diversity", "foreignAdmin");
  assert.equal(diversity.parse(await foreign.json()).total, 5);
});
test("recruiter diversity obeys requisition assignments; an empty manager scope stays empty", async () => {
  const own = await request("/analytics/diversity", "recruiter");
  assert.equal(diversity.parse(await own.json()).total, 5);
  const empty = await request("/analytics/diversity", "recruiterAdmin");
  assert.equal(diversity.parse(await empty.json()).total, 0);
  try {
    await dbAdmin
      .update(jobsTable)
      .set({ assignedRecruiterId: null })
      .where(eq(jobsTable.id, id("own")));
    assert.equal(
      diversity.parse(await (await request("/analytics/diversity", "recruiter")).json()).total,
      0,
    );
  } finally {
    await dbAdmin
      .update(jobsTable)
      .set({ assignedRecruiterId: id("recruiter") })
      .where(eq(jobsTable.id, id("own")));
  }
});
test("diversity suppresses the exact total below the disclosure threshold", async () => {
  const response = await request("/analytics/diversity", "smallAdmin");
  const data = diversity.parse(await response.json());
  assert.equal(data.total, 0);
  assert.deepEqual(data.gender, []);
  assert.deepEqual(data.bySource, []);
});
test("AEDT export seals the decision, job and application-stage joins", async () => {
  const response = await request("/analytics/aedt-export", "admin");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
  const csv = await response.text();
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 16); // header + 15 compliant decisions
  assert.ok(csv.includes(id("decision_own_0")));
  assert.ok(csv.includes(id("decision_child_0")));
  for (const value of ["FOREIGN_JOB_SENTINEL", id("foreign"), id("dnc"), id("erased")]) {
    assert.equal(csv.includes(value), false, value);
  }
  assert.equal(
    lines.some((line) => line.endsWith(",hired")),
    false,
  );
  const foreignJob = await request(`/analytics/aedt-export?jobId=${id("foreign")}`, "admin");
  assert.equal((await foreignJob.text()).trim().split("\n").length, 1);
});
const adverse = z.object({
  totalAnalyzed: z.number(),
  demographicCoverage: z.object({ totalUnits: z.number() }),
  attributes: z.array(
    z.object({
      key: z.string(),
      milestones: z.array(
        z.object({
          milestone: z.string(),
          groups: z.array(z.object({ appliedN: z.number(), reachedN: z.number() })),
        }),
      ),
    }),
  ),
});
test("adverse-impact scopes population and demographics identically and ignores foreign events", async () => {
  const response = await request(`/analytics/adverse-impact?jobId=${id("own")}`, "admin");
  assert.equal(response.status, 200);
  const data = adverse.parse(await response.json());
  assert.equal(data.totalAnalyzed, 5);
  assert.equal(data.demographicCoverage.totalUnits, 5);
  const hired = data.attributes
    .find((row) => row.key === "gender")
    ?.milestones.find((row) => row.milestone === "hired");
  assert.deepEqual(
    hired?.groups.map((group) => [group.appliedN, group.reachedN]),
    [[5, 1]],
  );
  const foreign = adverse.parse(
    await (await request(`/analytics/adverse-impact?jobId=${id("foreign")}`, "admin")).json(),
  );
  assert.equal(foreign.totalAnalyzed, 0);
  assert.equal(foreign.demographicCoverage.totalUnits, 0);
  const subtree = adverse.parse(await (await request("/analytics/adverse-impact", "admin")).json());
  assert.equal(subtree.totalAnalyzed, 15);
  assert.equal(subtree.demographicCoverage.totalUnits, 15);
  const sourced = adverse.parse(
    await (await request("/analytics/adverse-impact?population=sourced", "admin")).json(),
  );
  assert.equal(sourced.totalAnalyzed, 0);
  assert.equal(sourced.demographicCoverage.totalUnits, 0);
});
test("platform auditors retain explicit cross-employer job access", async () => {
  const response = await request(`/analytics/aedt-export?jobId=${id("foreign")}`, "platform");
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(id("decision_foreign_0")));
  const report = await request(`/analytics/adverse-impact?jobId=${id("foreign")}`, "platform");
  assert.equal(report.status, 200);
  assert.equal(adverse.parse(await report.json()).totalAnalyzed, 5);
});
test("suspension invalidates a previously issued admin token on all three surfaces", async () => {
  try {
    await dbAdmin
      .update(usersTable)
      .set({ status: "suspended" })
      .where(eq(usersTable.id, id("admin")));
    for (const path of [
      "/analytics/diversity",
      "/analytics/adverse-impact",
      "/analytics/aedt-export",
    ]) {
      assert.equal((await request(path, "admin")).status, 403);
    }
  } finally {
    await dbAdmin
      .update(usersTable)
      .set({ status: "active" })
      .where(eq(usersTable.id, id("admin")));
  }
});
