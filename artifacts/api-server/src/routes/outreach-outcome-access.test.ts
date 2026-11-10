import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  candidateOutcomesTable,
  outreachCampaignsTable,
  outreachEnrollmentsTable,
  outreachStepMessagesTable,
  auditLogsTable,
  communicationEventsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import outreachRouter from "./outreach";
import outcomeRouter from "./outcomes";
import replyRouter from "./outreach-reply";
import {
  createRecordedCommunicationSender,
  recordedCommunicationStore,
  type RecordedCommunication,
} from "../lib/recorded-communication";

const prefix = `outreach_access_${randomUUID().slice(0, 8)}_`;
const id = (name: string) => prefix + name;
const tenants = [id("a"), id("b")];
const accounts = {
  admin: ["a", "tenant_admin"],
  recruiter: ["a", "recruiter"],
  unassigned: ["a", "recruiter"],
  limited: ["a", "recruiter_admin"],
  candidate: ["a", "candidate"],
  manager: ["a", "hiring_manager"],
  interviewer: ["a", "interviewer"],
  foreign: ["b", "recruiter"],
  foreignAdmin: ["b", "tenant_admin"],
  platform: ["a", "platform_admin"],
} as const;
const fixtures = ["own", "foreign", "unassigned", "wrongCampaign", "wrongTenant"];
let server: Server | undefined;
let origin: string;

function token(name: keyof typeof accounts | "missing", claimedRole?: string) {
  const [tenant, role] = name === "missing" ? ["a", "tenant_admin"] : accounts[name];
  return issueToken({ userId: id(name), tenantId: id(tenant), role: claimedRole ?? role });
}
async function message(name: string) {
  const [row] = await dbAdmin
    .select()
    .from(outreachStepMessagesTable)
    .where(eq(outreachStepMessagesTable.id, id(name)));
  return row;
}
async function enrollment(name: string) {
  const [row] = await dbAdmin
    .select()
    .from(outreachEnrollmentsTable)
    .where(eq(outreachEnrollmentsTable.id, id(name)));
  return row;
}
async function request(method: string, path: string, auth?: string, body?: object) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload: unknown = await response.json();
  assert.ok(isRecord(payload), "Expected a JSON object");
  return { status: response.status, body: payload };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function reset(name: string, status = "pending_approval") {
  await dbAdmin
    .update(outreachStepMessagesTable)
    .set({
      status,
      subject: "Synthetic private draft",
      body: `PRIVATE_${name}`,
      scheduledFor: new Date("2099-01-01T00:00:00Z"),
      failedReason: null,
    })
    .where(eq(outreachStepMessagesTable.id, id(name)));
  // Stopped enrollments and disabled draft campaigns cannot dispatch a message
  // if the running application's scheduler observes these disposable rows.
  await dbAdmin
    .update(outreachEnrollmentsTable)
    .set({ status: "stopped" })
    .where(eq(outreachEnrollmentsTable.id, id(name)));
}
async function cleanup() {
  await dbAdmin
    .delete(communicationEventsTable)
    .where(inArray(communicationEventsTable.tenantId, [id("a"), id("b")]));
  await dbAdmin
    .delete(outreachStepMessagesTable)
    .where(inArray(outreachStepMessagesTable.id, fixtures.map(id)));
  await dbAdmin
    .delete(outreachEnrollmentsTable)
    .where(inArray(outreachEnrollmentsTable.id, fixtures.map(id)));
  await dbAdmin
    .delete(outreachCampaignsTable)
    .where(inArray(outreachCampaignsTable.tenantId, tenants));
  await dbAdmin
    .delete(candidateOutcomesTable)
    .where(inArray(candidateOutcomesTable.tenantId, tenants));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, tenants));
  await dbAdmin.delete(auditLogsTable).where(inArray(auditLogsTable.tenantId, tenants));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, tenants));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, Object.keys(accounts).map(id)));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, tenants));
}
before(async () => {
  await dbAdmin.insert(tenantsTable).values(
    tenants.map((tenant) => ({
      id: tenant,
      name: "Independent synthetic access fixture",
      slug: tenant,
      plan: "enterprise" as const,
    })),
  );
  await dbAdmin.insert(usersTable).values(
    Object.entries(accounts).map(([name, [tenant, role]]) => ({
      id: id(name),
      tenantId: id(tenant),
      role,
      name: "Synthetic reviewer",
      email: `${id(name)}@example.invalid`,
      passwordHash: "not-a-login-password",
    })),
  );
  for (const name of ["own", "foreign", "unassigned"]) {
    const tenant = name === "foreign" ? "b" : "a";
    await dbAdmin.insert(jobsTable).values({
      id: id(`job_${name}`),
      tenantId: id(tenant),
      title: "Synthetic access role",
      description: "Isolated test; no real candidate or outreach.",
      status: "active",
      assignedRecruiterId:
        name === "own" ? id("recruiter") : name === "foreign" ? id("foreign") : null,
    });
    await dbAdmin.insert(outreachCampaignsTable).values({
      id: id(`campaign_${name}`),
      tenantId: id(tenant),
      jobId: id(`job_${name}`),
      name: "Disabled synthetic campaign",
      status: "draft",
      autopilotEnabled: false,
    });
    await dbAdmin.insert(candidateOutcomesTable).values({
      tenantId: id(tenant),
      applicationId: id(`application_${name}`),
      candidateId: id(`candidate_${name}`),
      jobId: id(`job_${name}`),
      outcome: "hired",
      hireQualityScore: name === "own" ? 80 : name === "foreign" ? 20 : 90,
    });
  }
  for (const name of fixtures) {
    const parent = name === "foreign" || name === "unassigned" ? name : "own";
    const tenant = name === "foreign" || name === "wrongTenant" ? "b" : "a";
    await dbAdmin.insert(outreachEnrollmentsTable).values({
      id: id(name),
      campaignId: id(`campaign_${parent}`),
      jobId: id(`job_${parent}`),
      tenantId: id(tenant),
      candidateId: id(`candidate_${parent}`),
      status: "stopped",
      recipientEmail: `${id(name)}@example.invalid`,
    });
    await dbAdmin.insert(outreachStepMessagesTable).values({
      id: id(name),
      enrollmentId: id(name),
      campaignId: id(`campaign_${name === "wrongCampaign" ? "foreign" : parent}`),
      stepNumber: 1,
      toEmail: `${id(name)}@example.invalid`,
      subject: "Synthetic private draft",
      body: `PRIVATE_${name}`,
      status: "pending_approval",
      scheduledFor: new Date("2099-01-01T00:00:00Z"),
    });
  }
  for (const name of ["dnc", "erased"]) {
    await dbAdmin.insert(candidatesTable).values({
      id: id(name),
      tenantId: id("a"),
      firstName: "Synthetic",
      lastName: "Excluded",
      email: `${id(name)}@example.invalid`,
      pool: "tenant",
      doNotContact: name === "dnc",
    });
    await dbAdmin.insert(candidateOutcomesTable).values({
      tenantId: id("a"),
      applicationId: id(`application_${name}`),
      candidateId: id(name),
      jobId: id("job_own"),
      outcome: "hired",
      hireQualityScore: 99,
    });
    // Preserve the real erasure write barrier: seed the historical outcome
    // before erasure, rather than attempting an illegal post-erasure write.
    if (name === "erased") {
      await dbAdmin
        .update(candidatesTable)
        .set({ dataErasedAt: new Date() })
        .where(eq(candidatesTable.id, id(name)));
    }
  }
  const app = express();
  app.use(express.json(), outreachRouter, replyRouter, outcomeRouter);
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

const actions = [
  { method: "PATCH", suffix: "", body: { subject: "Reviewed subject", body: "Reviewed draft" } },
  { method: "POST", suffix: "/approve", body: {} },
  { method: "POST", suffix: "/reject", body: { reason: "Synthetic review only" } },
];
for (const action of actions) {
  const path = (name: string) => `/outreach/step-messages/${id(name)}${action.suffix}`;
  test(`${action.method} ${action.suffix || "edit"}: identity and actual staff role are required before mutation`, async () => {
    const original = await message("own");
    const parent = await enrollment("own");
    for (const [auth, status] of [
      [undefined, 401],
      [token("missing"), 401],
      [token("candidate"), 403],
      [token("candidate", "tenant_admin"), 403],
    ] as const) {
      assert.equal((await request(action.method, path("own"), auth, action.body)).status, status);
    }
    assert.deepEqual(await message("own"), original);
    assert.deepEqual(await enrollment("own"), parent);
  });
  test(`${action.method} ${action.suffix || "edit"}: foreign and missing resources share 404 without writes`, async () => {
    const original = await message("foreign");
    const parent = await enrollment("foreign");
    const foreign = await request(action.method, path("foreign"), token("admin"), action.body);
    const missing = await request(action.method, path("missing"), token("admin"), action.body);
    assert.deepEqual(foreign, { status: 404, body: { error: "Not found" } });
    assert.deepEqual(missing, foreign);
    assert.deepEqual(await message("foreign"), original);
    assert.deepEqual(await enrollment("foreign"), parent);
  });
  test(`${action.method} ${action.suffix || "edit"}: recruiter assignments and limited admin scope remain enforced`, async () => {
    for (const [account, target] of [
      ["unassigned", "own"],
      ["recruiter", "unassigned"],
      ["limited", "own"],
    ] as const) {
      const original = await message(target);
      assert.equal(
        (await request(action.method, path(target), token(account), action.body)).status,
        404,
      );
      assert.deepEqual(await message(target), original);
    }
  });
  test(`${action.method} ${action.suffix || "edit"}: inconsistent parent associations cannot authorise a draft`, async () => {
    for (const [account, target] of [
      ["admin", "wrongCampaign"],
      ["foreignAdmin", "wrongTenant"],
    ] as const) {
      const original = await message(target);
      const parent = await enrollment(target);
      assert.equal(
        (await request(action.method, path(target), token(account), action.body)).status,
        404,
      );
      assert.deepEqual(await message(target), original);
      assert.deepEqual(await enrollment(target), parent);
    }
  });
  test(`${action.method} ${action.suffix || "edit"}: assigned recruiter retains valid draft review`, async () => {
    await reset("own");
    const response = await request(action.method, path("own"), token("recruiter"), action.body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const saved = await message("own");
    if (!action.suffix) {
      assert.equal(saved.body, "Reviewed draft");
      assert.equal(saved.subject, "Reviewed subject");
    } else if (action.suffix === "/approve") {
      assert.equal(saved.status, "scheduled");
      assert.equal(response.body.queuedForSend, true);
      // Cancel the fixture immediately; this test is approval, not delivery.
      await dbAdmin
        .update(outreachStepMessagesTable)
        .set({ status: "cancelled" })
        .where(eq(outreachStepMessagesTable.id, saved.id));
    } else {
      assert.equal(saved.status, "cancelled");
      assert.equal((await enrollment("own")).status, "stopped");
    }
    await reset("own");
  });
}

test("approval idempotency never bypasses ownership or disclose a foreign draft", async () => {
  await reset("foreign", "scheduled");
  const path = `/outreach/step-messages/${id("foreign")}/approve`;
  assert.equal((await request("POST", path, token("admin"), {})).status, 404);
  const authorised = await request("POST", path, token("foreign"), {});
  assert.equal(authorised.status, 200);
  assert.equal(authorised.body.body, "PRIVATE_foreign");
  await reset("foreign");
});
test("platform access retains the explicit all-tenant exception", async () => {
  const response = await request(
    "PATCH",
    `/outreach/step-messages/${id("foreign")}`,
    token("platform"),
    { body: "Platform reviewed" },
  );
  assert.equal(response.status, 200);
  assert.equal((await message("foreign")).body, "Platform reviewed");
});
test("existing hiring-manager and interviewer staff access is retained", async () => {
  for (const account of ["manager", "interviewer"] as const) {
    const response = await request(
      "PATCH",
      `/outreach/step-messages/${id("own")}`,
      token(account),
      { body: "Staff reviewed" },
    );
    assert.equal(response.status, 200);
    assert.equal((await message("own")).body, "Staff reviewed");
  }
});
test("enrollment refuses another requisition before creating inconsistent drafts", async () => {
  const original = await enrollment("own");
  const response = await request(
    "POST",
    `/outreach/campaigns/${id("campaign_own")}/enroll`,
    token("admin"),
    { candidateId: id("candidate_own"), jobId: id("job_unassigned") },
  );
  assert.deepEqual(response, { status: 404, body: { error: "Job not found" } });
  assert.deepEqual(await enrollment("own"), original);
});
test("public reply links still reach their HMAC verifier without staff authentication", async () => {
  for (const path of ["/outreach/reply/invalid-token", "/outreach/reply-msg/invalid-token"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 400);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
  }
});
test("coverage requires an existing staff account, not a candidate token or claimed staff role", async () => {
  for (const [auth, status] of [
    [undefined, 401],
    [token("missing"), 401],
    [token("candidate"), 403],
    [token("candidate", "tenant_admin"), 403],
  ] as const) {
    assert.equal((await request("GET", "/outcomes/coverage", auth)).status, status);
  }
});
test("coverage keeps positive customer controls, recruiter ownership, empty scope and compliance", async () => {
  for (const [account, hires, quality] of [
    ["admin", 2, 85],
    ["recruiter", 1, 80],
    ["foreign", 1, 20],
    ["foreignAdmin", 1, 20],
    ["unassigned", 0, null],
    ["limited", 0, null],
    ["manager", 2, 85],
    ["interviewer", 2, 85],
  ] as const) {
    const response = await request("GET", "/outcomes/coverage", token(account));
    assert.equal(response.status, 200);
    assert.equal(response.body.hires, hires, account);
    assert.equal(response.body.hiresWithQuality, hires, account);
    assert.equal(response.body.avgHireQualityScore, quality, account);
    assert.equal(response.body.qualityCoveragePct, hires ? 100 : 0, account);
    assert.ok(isRecord(response.body.outcomes));
    assert.equal(response.body.outcomes.hired, hires, account);
  }
});
test("simulation preserves failed, claimed and unapproved step history without changing the enrollment clock", async () => {
  const originalMessage = await message("own");
  const originalEnrollment = await enrollment("own");
  try {
    await dbAdmin
      .update(outreachEnrollmentsTable)
      .set({
        currentStep: 0,
        status: "active",
        lastSentAt: new Date("2026-01-01T00:00:00Z"),
      })
      .where(eq(outreachEnrollmentsTable.id, id("own")));
    for (const [status, failedReason] of [
      ["failed", "Older result without acceptance evidence"],
      ["failed", "Outlook outcome uncertain. Review the original attempt."],
      ["scheduled", "provider_outcome_uncertain:synthetic-claim"],
      ["pending_approval", null],
      ["sent", null],
    ] as const) {
      await dbAdmin
        .update(outreachStepMessagesTable)
        .set({ status, failedReason })
        .where(eq(outreachStepMessagesTable.id, id("own")));
      const priorMessage = await message("own"),
        priorEnrollment = await enrollment("own");
      const response = await request(
        "POST",
        `/outreach/enrollments/${id("own")}/simulate-next`,
        token("admin"),
        {},
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await message("own"), priorMessage);
      assert.deepEqual(await enrollment("own"), priorEnrollment);
    }
  } finally {
    await dbAdmin
      .update(outreachStepMessagesTable)
      .set({
        status: originalMessage.status,
        failedReason: originalMessage.failedReason,
      })
      .where(eq(outreachStepMessagesTable.id, id("own")));
    await dbAdmin
      .update(outreachEnrollmentsTable)
      .set({
        currentStep: originalEnrollment.currentStep,
        status: originalEnrollment.status,
        lastSentAt: originalEnrollment.lastSentAt,
        updatedAt: originalEnrollment.updatedAt,
      })
      .where(eq(outreachEnrollmentsTable.id, id("own")));
  }
});
test("real communication claims prevent concurrent/replayed sends and keep foreign-tenant collisions private", async () => {
  const input: RecordedCommunication = {
    id: id("manual_reply"),
    tenantId: id("a"),
    candidateId: id("candidate_own"),
    type: "follow_up",
    to: "fixture@example.invalid",
    subject: "Synthetic fixture",
    body: "PRIVATE synthetic reply",
    actorLabel: "Fixture only",
    action: "outreach.inbox_reply.sent",
  };
  let release: () => void = () => {},
    started: () => void = () => {},
    sends = 0;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sender = createRecordedCommunicationSender({
    ...recordedCommunicationStore,
    send: async (opts) => {
      sends++;
      assert.equal(opts.singleAttempt, true);
      started();
      await wait;
      return { ok: true, acceptance: "accepted", delivery: "unverified" };
    },
  });
  const first = sender(input);
  try {
    await Promise.race([
      began,
      first.then(() => assert.fail("Claim did not reach the mocked provider")),
    ]);
    assert.equal((await sender(input)).reviewRequired, true);
    const foreign = await sender({
      ...input,
      tenantId: id("b"),
      candidateId: id("candidate_foreign"),
    });
    assert.equal(foreign.reviewRequired, true);
    assert.ok(!foreign.error?.includes("PRIVATE"));
  } finally {
    release();
  }
  assert.equal((await first).ok, true);
  assert.equal((await sender(input)).ok, true);
  assert.equal(sends, 1);
  const [row] = await dbAdmin
    .select()
    .from(communicationEventsTable)
    .where(eq(communicationEventsTable.id, input.id));
  assert.equal(row.status, "sent");
  assert.ok(row.sentAt);
  assert.equal(row.body, input.body);
});
test("real pending communication history survives provider uncertainty and final-write failure", async () => {
  for (const failFinalWrite of [false, true]) {
    const input: RecordedCommunication = {
      id: id(`held_reply_${failFinalWrite}`),
      tenantId: id("a"),
      candidateId: id("candidate_own"),
      type: "follow_up",
      to: "fixture@example.invalid",
      subject: "Synthetic held fixture",
      body: "PRIVATE held fixture",
      actorLabel: "Fixture only",
      action: "outreach.inbox_reply.sent",
    };
    let sends = 0;
    const sender = createRecordedCommunicationSender({
      ...recordedCommunicationStore,
      ...(failFinalWrite
        ? {
            finish: async () => {
              throw Error("Synthetic lost write");
            },
          }
        : {}),
      send: async () => {
        sends++;
        return failFinalWrite ? { ok: true } : { ok: false, reviewRequired: true };
      },
    });
    assert.equal((await sender(input)).reviewRequired, true);
    const reloaded = createRecordedCommunicationSender({
      ...recordedCommunicationStore,
      send: async () => {
        sends++;
        throw Error("Must not resend after reload");
      },
    });
    assert.equal((await reloaded(input)).reviewRequired, true);
    assert.equal(sends, 1);
    const [row] = await dbAdmin
      .select()
      .from(communicationEventsTable)
      .where(eq(communicationEventsTable.id, input.id));
    assert.equal(row.status, "pending");
    assert.equal(row.sentAt, null);
    assert.equal(row.body, input.body);
  }
});
