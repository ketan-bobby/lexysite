import { after, before, mock, test } from "node:test";
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
  candidateCareerProfilesTable,
  jobsTable,
  jobRecruitersTable,
  applicationsTable,
  candidateJobIntelligenceTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { orchestrator } from "../lib/agents/orchestrator";
import { logger } from "../lib/logger";

const prefix = `jdp_${crypto.randomUUID().slice(0, 8)}_`;
const id = (value: string) => prefix + value;
const companyName = id("Employer");
const candidateIds = ["own", "foreign", "malformed"].map(id);
const tenantIds = ["tenant", "foreignTenant"].map(id);
const userIds = ["admin", "candidateUser"].map(id);
const privateSentinel = id("PRIVATE_BASELINE");
const alerts: unknown[] = [];
const aiCalls: unknown[][] = [];
const completed = new Map<string, boolean>();
const waiters = new Map<string, (success: boolean) => void>();
const jobIds: string[] = [];
const emitter = await import("../lib/market-event-emitter");
mock.module(new URL("../lib/market-event-emitter.ts", import.meta.url), {
  namedExports: {
    ...emitter,
    // Exercise the real role-creation read/matcher, but never send email or
    // write private events for an existing development candidate.
    recordRoleOpenAtTarget: async (value: unknown) => {
      alerts.push(structuredClone(value));
    },
  },
});
const { default: jobsRouter } = await import("./jobs");
let server: Server;
let base: string;

function trackCompletion(fields: unknown, message: unknown) {
  if (message !== "Role-open fan-out complete" && message !== "Role-open fan-out failed") return;
  const parsed = z.object({ jobId: z.string() }).safeParse(fields);
  if (!parsed.success) return;
  const success = message === "Role-open fan-out complete";
  completed.set(parsed.data.jobId, success);
  waiters.get(parsed.data.jobId)?.(success);
}
function waitForFanout(jobId: string): Promise<boolean> {
  if (completed.has(jobId)) return Promise.resolve(completed.get(jobId)!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(jobId);
      reject(new Error("Job alert background work did not finish"));
    }, 10_000);
    waiters.set(jobId, (success) => {
      clearTimeout(timer);
      waiters.delete(jobId);
      resolve(success);
    });
  });
}
const jobResponse = z.object({ id: z.string(), title: z.string() });
const alert = z
  .object({
    candidateId: z.string(),
    jobId: z.string(),
    companyName: z.string(),
    roleTitle: z.string(),
  })
  .strict();
const description =
  "A factual job description with sufficient length for the existing ICP trigger.";
async function createJob(user: "admin" | "candidateUser" = "admin", publish = true) {
  const response = await fetch(base + "/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${issueToken({
        userId: id(user),
        tenantId: id("tenant"),
        role: user === "admin" ? "tenant_admin" : "candidate",
      })}`,
    },
    body: JSON.stringify({ title: "Fixture engineer", description }),
  });
  const body: unknown = await response.json();
  if (response.status === 201) {
    const jobId = jobResponse.parse(body).id;
    jobIds.push(jobId);
    // Active work orders are internal. Only explicit publication may fan out.
    if (publish) {
      const publication = await fetch(base + `/jobs/${jobId}/publish`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${issueToken({ userId: id("admin"), tenantId: id("tenant"), role: "tenant_admin" })}`,
        },
        body: "{}",
      });
      assert.equal(publication.status, 200);
    }
  }
  return { response, body };
}
before(async () => {
  mock.method(orchestrator, "triggerAgent", async (...args: unknown[]) => {
    aiCalls.push(structuredClone(args));
  });
  mock.method(logger, "info", trackCompletion);
  mock.method(logger, "warn", trackCompletion);
  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenant"), name: companyName, slug: id("tenant"), plan: "enterprise" },
    { id: id("foreignTenant"), name: id("Foreign"), slug: id("foreignTenant") },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: id("admin"),
      tenantId: id("tenant"),
      name: "Fixture admin",
      role: "tenant_admin",
      status: "active",
      email: `${id("admin")}@example.invalid`,
      passwordHash: "unused",
    },
    {
      id: id("candidateUser"),
      tenantId: id("tenant"),
      name: "Fixture candidate",
      role: "candidate",
      status: "active",
      email: `${id("candidateUser")}@example.invalid`,
      passwordHash: "unused",
    },
  ]);
  await dbAdmin.insert(candidatesTable).values(
    candidateIds.map((candidateId, index) => ({
      id: candidateId,
      tenantId: id(index === 1 ? "foreignTenant" : "tenant"),
      userId: index === 0 ? id("candidateUser") : null,
      firstName: "Fixture",
      lastName: "Candidate",
      currentTitle: "Engineer",
      email: `${candidateId}@example.invalid`,
      pool: "tenant" as const,
    })),
  );
  await dbAdmin.insert(candidateCareerProfilesTable).values(
    candidateIds.map((candidateId, index) => ({
      candidateId,
      targetCompanies: index === 2 ? [] : [companyName],
      baselineConversation: [{ role: "user", content: privateSentinel }],
    })),
  );
  const app = express();
  app.use(express.json());
  app.use(jobsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  mock.restoreAll();
  if (jobIds.length) {
    await dbAdmin.delete(jobRecruitersTable).where(inArray(jobRecruitersTable.jobId, jobIds));
    await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
  await dbAdmin
    .delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, candidateIds));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, candidateIds));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, userIds));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
});

test("private company preferences produce private alert callbacks, never employer data or scoring work", async () => {
  const { response, body } = await createJob();
  assert.equal(response.status, 201);
  const job = jobResponse.parse(body);
  assert.equal(await waitForFanout(job.id), true);
  assert.equal(JSON.stringify(body).includes(privateSentinel), false);
  for (const candidateId of candidateIds) {
    assert.equal(JSON.stringify(body).includes(candidateId), false);
  }
  const recipients = alerts
    .map((value) => alert.parse(value))
    .filter((value) => value.jobId === job.id && candidateIds.includes(value.candidateId));
  assert.deepEqual(
    new Set(recipients.map((value) => value.candidateId)),
    new Set([id("own"), id("foreign")]),
  );
  for (const notification of recipients) {
    assert.equal(notification.companyName, companyName);
    assert.equal(notification.roleTitle, "Fixture engineer");
  }
  assert.deepEqual(aiCalls, [
    [
      "icp",
      {
        jobId: job.id,
        title: "Fixture engineer",
        description,
        department: undefined,
        location: undefined,
      },
      "orchestrator",
    ],
  ]);
  assert.deepEqual(
    await dbAdmin.select().from(applicationsTable).where(eq(applicationsTable.jobId, job.id)),
    [],
  );
  assert.deepEqual(
    await dbAdmin
      .select()
      .from(candidateJobIntelligenceTable)
      .where(eq(candidateJobIntelligenceTable.jobId, job.id)),
    [],
  );
});

test("changing baseline content does not change employer AI input or create hiring evidence", async () => {
  await dbAdmin
    .update(candidateCareerProfilesTable)
    .set({
      baselineConversation: [
        { role: "user", content: `${privateSentinel}_CHANGED_GAPS_AND_FEEDBACK` },
      ],
    })
    .where(inArray(candidateCareerProfilesTable.candidateId, candidateIds));
  const previousCalls = aiCalls.length;
  const { response, body } = await createJob();
  assert.equal(response.status, 201);
  const job = jobResponse.parse(body);
  assert.equal(await waitForFanout(job.id), true);
  assert.deepEqual(aiCalls.slice(previousCalls), [
    [
      "icp",
      {
        jobId: job.id,
        title: "Fixture engineer",
        description,
        department: undefined,
        location: undefined,
      },
      "orchestrator",
    ],
  ]);
  assert.equal(JSON.stringify(body).includes(privateSentinel), false);
  assert.deepEqual(
    await dbAdmin
      .select()
      .from(candidateJobIntelligenceTable)
      .where(eq(candidateJobIntelligenceTable.jobId, job.id)),
    [],
  );
});

test("malformed legacy preferences cannot starve other candidates' alerts", async () => {
  // Deliberately malformed persisted JSON, not an accepted API payload.
  await dbAdmin
    .update(candidateCareerProfilesTable)
    .set({ targetCompanies: [null, 42, companyName] as unknown as string[] })
    .where(eq(candidateCareerProfilesTable.candidateId, id("foreign")));
  await dbAdmin
    .update(candidateCareerProfilesTable)
    .set({ targetCompanies: "not-an-array" as unknown as string[] })
    .where(eq(candidateCareerProfilesTable.candidateId, id("malformed")));
  const { response, body } = await createJob();
  assert.equal(response.status, 201);
  const job = jobResponse.parse(body);
  assert.equal(await waitForFanout(job.id), true);
  const recipients = alerts
    .map((value) => alert.parse(value))
    .filter((value) => value.jobId === job.id && candidateIds.includes(value.candidateId));
  assert.deepEqual(
    new Set(recipients.map((value) => value.candidateId)),
    new Set([id("own"), id("foreign")]),
  );
});

test("a candidate account cannot create a work order or trigger employer AI work", async () => {
  const calls = aiCalls.length;
  const notifications = alerts.length;
  assert.equal((await createJob("candidateUser")).response.status, 403);
  assert.equal(aiCalls.length, calls);
  assert.equal(alerts.length, notifications);
});

async function staffChange(jobId: string, suffix: string, body = {}, method = "PATCH") {
  return fetch(base + `/jobs/${jobId}${suffix}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${issueToken({ userId: id("admin"), tenantId: id("tenant"), role: "tenant_admin" })}`,
    },
    body: JSON.stringify(body),
  });
}
function fixtureAlerts(jobId: string) {
  return alerts
    .map((value) => alert.parse(value))
    .filter((value) => value.jobId === jobId && candidateIds.includes(value.candidateId));
}
test("creation and approval stay private; explicit publication delivers the deferred alerts", async () => {
  const { response, body } = await createJob("admin", false);
  assert.equal(response.status, 201);
  const jobId = jobResponse.parse(body).id;
  assert.equal(fixtureAlerts(jobId).length, 0);
  // Seed a pending fixture without a self-approval conflict. Exercise the real
  // approval/publication endpoints, not an emitter-only simulation.
  await dbAdmin
    .update(jobsTable)
    .set({ status: "pending_approval", createdById: null })
    .where(eq(jobsTable.id, jobId));
  assert.equal((await staffChange(jobId, "/publish")).status, 400);
  assert.equal((await staffChange(jobId, "", { status: "published" }, "PUT")).status, 400);
  assert.equal((await staffChange(jobId, "", { status: "active" }, "PUT")).status, 400);
  assert.equal(fixtureAlerts(jobId).length, 0);
  assert.equal((await staffChange(jobId, "/approve")).status, 200);
  assert.equal(fixtureAlerts(jobId).length, 0);
  assert.equal((await staffChange(jobId, "/publish")).status, 200);
  assert.equal(await waitForFanout(jobId), true);
  assert.equal(fixtureAlerts(jobId).length, 2);
});
test("confidential publication stays quiet; explicitly clearing confidentiality recovers alerts", async () => {
  const { response, body } = await createJob("admin", false);
  assert.equal(response.status, 201);
  const jobId = jobResponse.parse(body).id;
  await dbAdmin.update(jobsTable).set({ isConfidential: true }).where(eq(jobsTable.id, jobId));
  assert.equal((await staffChange(jobId, "/publish")).status, 200);
  assert.equal(await waitForFanout(jobId), true);
  assert.equal(fixtureAlerts(jobId).length, 0);
  const candidateEdit = await fetch(base + `/jobs/${jobId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${issueToken({ userId: id("candidateUser"), tenantId: id("tenant"), role: "candidate" })}`,
    },
    body: JSON.stringify({ isConfidential: false }),
  });
  assert.equal(candidateEdit.status, 403);
  const [unchanged] = await dbAdmin
    .select({ confidential: jobsTable.isConfidential })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  assert.equal(unchanged.confidential, true);
  completed.delete(jobId);
  assert.equal((await staffChange(jobId, "", { isConfidential: false }, "PUT")).status, 200);
  assert.equal(await waitForFanout(jobId), true);
  assert.equal(fixtureAlerts(jobId).length, 2);
});
