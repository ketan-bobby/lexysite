/**
 * Candidate development firewall — behavioural regressions for the privacy
 * boundary between a candidate's baseline/practice material and a job-specific
 * client assessment. The test uses real routers and bearer identities.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { jsonObjectSchema, jsonRowsSchema } from "../test-utils/json-response";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  applicationsTable,
  candidateCareerProfilesTable,
  candidatesTable,
  dbAdmin,
  interviewPlansTable,
  interviewSessionsTable,
  jobsTable,
  prepSessionsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import candidatesRouter from "./candidates";
import careerProfileRouter from "./career-profile";
import interviewsRouter from "./interviews";
import prepRouter from "./prep";

const P = `devfw_${crypto.randomUUID().slice(0, 8)}_`;
const id = (value: string) => P + value;
const tenantId = id("tenant");
const ownerUserId = id("owner_user");
const peerUserId = id("peer_user");
const staffUserId = id("staff_user");
const platformUserId = id("platform_user");
const ownerCandidateId = id("owner_candidate");
const peerCandidateId = id("peer_candidate");
const jobId = id("job");
const jobPlanId = id("job_plan");
const jobApplicationId = id("job_application");
const jobSessionId = id("job_session");
const prepSessionId = id("prep_session");

let baseUrl = "";
let server: Server | undefined;

const token = (userId: string, role: string) => issueToken({ userId, role, tenantId });

async function request(method: string, path: string, bearer: string, body?: unknown) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function cleanup() {
  await dbAdmin
    .delete(prepSessionsTable)
    .where(eq(prepSessionsTable.id, prepSessionId))
    .catch(() => {});
  await dbAdmin
    .delete(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, jobSessionId))
    .catch(() => {});
  await dbAdmin
    .delete(interviewPlansTable)
    .where(eq(interviewPlansTable.id, jobPlanId))
    .catch(() => {});
  await dbAdmin
    .delete(applicationsTable)
    .where(eq(applicationsTable.id, jobApplicationId))
    .catch(() => {});
  await dbAdmin
    .delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, [ownerCandidateId, peerCandidateId]))
    .catch(() => {});
  await dbAdmin
    .delete(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .catch(() => {});
  await dbAdmin
    .delete(candidatesTable)
    .where(inArray(candidatesTable.id, [ownerCandidateId, peerCandidateId]))
    .catch(() => {});
  await dbAdmin
    .delete(usersTable)
    .where(inArray(usersTable.id, [ownerUserId, peerUserId, staffUserId, platformUserId]))
    .catch(() => {});
  await dbAdmin
    .delete(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .catch(() => {});
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({
    id: tenantId,
    name: "Development Firewall Tenant",
    slug: tenantId,
    plan: "enterprise",
  });
  await dbAdmin.insert(usersTable).values([
    {
      id: ownerUserId,
      tenantId,
      email: `${ownerUserId}@test.invalid`,
      name: "Owner",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: peerUserId,
      tenantId,
      email: `${peerUserId}@test.invalid`,
      name: "Peer",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: staffUserId,
      tenantId,
      email: `${staffUserId}@test.invalid`,
      name: "Staff",
      passwordHash: "x",
      role: "tenant_admin",
    },
    {
      id: platformUserId,
      tenantId,
      email: `${platformUserId}@test.invalid`,
      name: "Platform",
      passwordHash: "x",
      role: "platform_admin",
    },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    {
      id: ownerCandidateId,
      tenantId,
      userId: ownerUserId,
      firstName: "Private",
      lastName: "Owner",
      email: `${ownerCandidateId}@test.invalid`,
      pool: "tenant",
    },
    {
      id: peerCandidateId,
      tenantId,
      userId: peerUserId,
      firstName: "Private",
      lastName: "Peer",
      email: `${peerCandidateId}@test.invalid`,
      pool: "tenant",
    },
  ]);
  await dbAdmin.insert(jobsTable).values({
    id: jobId,
    tenantId,
    title: "Scoped Job",
    description: "Job scope",
    status: "active",
  });
  await dbAdmin.insert(candidateCareerProfilesTable).values({
    candidateId: ownerCandidateId,
    aiSummary: "PRIVATE BASELINE SUMMARY",
    transcriptEnglish: "PRIVATE BASELINE TRANSCRIPT",
    baselineConversation: [{ role: "user", content: "PRIVATE BASELINE ANSWER" }],
    recordingUrl: "/recordings/11111111-1111-1111-1111-111111111111/",
  } as any);
  await dbAdmin.insert(prepSessionsTable).values({
    id: prepSessionId,
    tenantId,
    candidateId: ownerCandidateId,
    jobId,
    mode: "quick",
    status: "active",
    questions: ["PRIVATE PRACTICE QUESTION"],
    answers: [{ questionId: "q1", answer: "PRIVATE PRACTICE ANSWER" }],
    totalQuestions: 1,
    questionsAnswered: 1,
  });
  await dbAdmin.insert(interviewPlansTable).values({
    id: jobPlanId,
    tenantId,
    jobId,
    title: "Scoped plan",
    questions: [],
  });
  await dbAdmin.insert(applicationsTable).values({
    id: jobApplicationId,
    tenantId,
    jobId,
    candidateId: ownerCandidateId,
    stage: "applied",
  });
  await dbAdmin.insert(interviewSessionsTable).values([
    {
      id: jobSessionId,
      tenantId,
      candidateId: ownerCandidateId,
      applicationId: jobApplicationId,
      planId: jobPlanId,
      status: "completed",
      totalQuestions: 1,
    },
  ]);

  const app = express();
  app.use(express.json());
  app.use(prepRouter);
  app.use(candidatesRouter);
  app.use(careerProfileRouter);
  app.use(interviewsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      assert.ok(server);
      const address = server.address();
      baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await cleanup();
});

test("developmental profile and preparation stay candidate-self-only", async () => {
  const owner = await request(
    "GET",
    `/candidates/${ownerCandidateId}/career-profile`,
    token(ownerUserId, "candidate"),
  );
  assert.equal(owner.status, 200);
  const ownerBody = jsonObjectSchema.parse(owner.body);
  assert.equal(ownerBody.exists, true);
  assert.equal(ownerBody.transcriptEnglish, "PRIVATE BASELINE TRANSCRIPT");

  for (const bearer of [
    token(peerUserId, "candidate"),
    token(staffUserId, "tenant_admin"),
    token(platformUserId, "platform_admin"),
  ]) {
    const hidden = await request("GET", `/candidates/${ownerCandidateId}/career-profile`, bearer);
    assert.deepEqual(hidden, {
      status: 200,
      body: { exists: false, candidateId: ownerCandidateId },
    });
    assert.equal(JSON.stringify(hidden.body).includes("PRIVATE BASELINE"), false);
  }

  const ownPrep = await request("GET", "/prep/sessions", token(ownerUserId, "candidate"));
  assert.equal(ownPrep.status, 200);
  assert.equal(JSON.stringify(ownPrep.body).includes("PRIVATE PRACTICE ANSWER"), true);

  const staffPrep = await request("GET", "/prep/sessions", token(staffUserId, "tenant_admin"));
  assert.equal(staffPrep.status, 403);
  assert.equal(JSON.stringify(staffPrep.body).includes("PRIVATE PRACTICE"), false);
  const staffGenerate = await request(
    "POST",
    "/prep/generate",
    token(staffUserId, "tenant_admin"),
    { candidateId: ownerCandidateId, jobId, mode: "quick" },
  );
  assert.equal(staffGenerate.status, 403);
});

test("baseline playback is denied to staff while job-specific sessions remain visible", async () => {
  const staffPlayback = await request(
    "GET",
    `/portal/career-interview/recording-playback-url/${ownerCandidateId}`,
    token(platformUserId, "platform_admin"),
  );
  assert.equal(staffPlayback.status, 404);

  const staffRecording = await request(
    "GET",
    `/candidates/${ownerCandidateId}/career-recording`,
    token(staffUserId, "tenant_admin"),
  );
  assert.equal(staffRecording.status, 404);

  const sessions = await request("GET", "/interviews", token(platformUserId, "platform_admin"));
  assert.equal(sessions.status, 200);
  const ids = new Set(jsonRowsSchema.parse(sessions.body).map((session) => session.id));
  assert.equal(
    ids.has(jobSessionId),
    true,
    "job-specific assessment remains operationally visible",
  );
});

test("candidate detail is staff-only, not a same-tenant candidate directory", async () => {
  for (const candidateId of [ownerCandidateId, peerCandidateId, id("missing_candidate")]) {
    const response = await request(
      "GET",
      `/candidates/${candidateId}`,
      token(ownerUserId, "candidate"),
    );
    assert.equal(response.status, 403);
    assert.equal(JSON.stringify(response.body).includes("Private"), false);
  }
  const allowed = await request(
    "GET",
    `/candidates/${ownerCandidateId}`,
    token(staffUserId, "tenant_admin"),
  );
  assert.equal(allowed.status, 200);
  const forgedRole = await request(
    "GET",
    `/candidates/${ownerCandidateId}`,
    token(ownerUserId, "platform_admin"),
  );
  assert.equal(forgedRole.status, 403, "current database role overrides stale token role");
});

test("suspension immediately closes candidate detail and private profile reads", async () => {
  for (const [userId, role, paths] of [
    [staffUserId, "tenant_admin", [`/candidates/${ownerCandidateId}`, "/clients"]],
    [
      ownerUserId,
      "candidate",
      [
        `/candidates/${ownerCandidateId}/career-profile`,
        `/candidates/${ownerCandidateId}/career-recording`,
      ],
    ],
  ] as const) {
    await dbAdmin.update(usersTable).set({ status: "suspended" }).where(eq(usersTable.id, userId));
    try {
      for (const path of paths) {
        const response = await request("GET", path, token(userId, role));
        assert.equal(response.status, 401, path);
        assert.equal(JSON.stringify(response.body).includes("PRIVATE BASELINE"), false);
      }
    } finally {
      await dbAdmin.update(usersTable).set({ status: "active" }).where(eq(usersTable.id, userId));
    }
  }
});

test("career recording denial is uniform for peers, staff, administrators and missing IDs", async () => {
  for (const bearer of [
    token(peerUserId, "candidate"),
    token(staffUserId, "tenant_admin"),
    token(platformUserId, "platform_admin"),
  ]) {
    for (const candidateId of [ownerCandidateId, id("missing_candidate")]) {
      const response = await request("GET", `/candidates/${candidateId}/career-recording`, bearer);
      assert.deepEqual(response, { status: 404, body: { error: "Not found" } });
    }
  }
});

test("candidate detail and developmental endpoints require a signed-in active user", async () => {
  for (const suffix of ["", "/career-profile", "/career-recording"]) {
    const response = await request("GET", `/candidates/${ownerCandidateId}${suffix}`, "");
    assert.deepEqual(response, { status: 401, body: { error: "Unauthorized" } });
  }
});

test("candidate detail preserves tenant boundaries and positive in-scope access", async () => {
  const foreignTenantId = id("foreign_tenant");
  await dbAdmin.insert(tenantsTable).values({
    id: foreignTenantId,
    name: "Synthetic foreign employer",
    slug: foreignTenantId,
    plan: "enterprise",
  });
  try {
    await dbAdmin
      .update(candidatesTable)
      .set({ tenantId: foreignTenantId })
      .where(eq(candidatesTable.id, peerCandidateId));
    for (const candidateId of [peerCandidateId, id("missing_candidate")]) {
      const response = await request(
        "GET",
        `/candidates/${candidateId}`,
        token(staffUserId, "tenant_admin"),
      );
      assert.deepEqual(response, { status: 404, body: { error: "Not found" } });
    }
    const allowed = await request(
      "GET",
      `/candidates/${ownerCandidateId}`,
      token(staffUserId, "tenant_admin"),
    );
    assert.equal(allowed.status, 200);
    assert.equal(jsonObjectSchema.parse(allowed.body).hasPortalAccess, true);
    assert.equal(JSON.stringify(allowed.body).includes("PRIVATE BASELINE"), false);
  } finally {
    await dbAdmin
      .update(candidatesTable)
      .set({ tenantId })
      .where(eq(candidatesTable.id, peerCandidateId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, foreignTenantId));
  }
});

test("recruiter detail access follows current requisition assignment, not tenant alone", async () => {
  await dbAdmin.update(usersTable).set({ role: "recruiter" }).where(eq(usersTable.id, staffUserId));
  const bearer = token(staffUserId, "recruiter");
  const detail = (candidateId: string) => request("GET", `/candidates/${candidateId}`, bearer);
  try {
    assert.equal((await detail(ownerCandidateId)).status, 404);
    await dbAdmin
      .update(jobsTable)
      .set({ assignedRecruiterId: staffUserId })
      .where(eq(jobsTable.id, jobId));
    assert.equal((await detail(ownerCandidateId)).status, 200);
    assert.equal((await detail(peerCandidateId)).status, 404);
    assert.equal((await detail(id("missing_candidate"))).status, 404);
    await dbAdmin
      .update(jobsTable)
      .set({ assignedRecruiterId: null })
      .where(eq(jobsTable.id, jobId));
    assert.equal((await detail(ownerCandidateId)).status, 404);
  } finally {
    await dbAdmin
      .update(jobsTable)
      .set({ assignedRecruiterId: null })
      .where(eq(jobsTable.id, jobId));
    await dbAdmin
      .update(usersTable)
      .set({ role: "tenant_admin" })
      .where(eq(usersTable.id, staffUserId));
  }
});
