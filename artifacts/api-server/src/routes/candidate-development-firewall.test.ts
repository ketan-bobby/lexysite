/**
 * Candidate development firewall — behavioural regressions for the privacy
 * boundary between a candidate's baseline/practice material and a job-specific
 * client assessment. The test uses real routers and bearer identities.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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

const token = (userId: string, role: string) =>
  issueToken({ userId, role, tenantId });

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
  await dbAdmin.delete(prepSessionsTable).where(eq(prepSessionsTable.id, prepSessionId)).catch(() => {});
  await dbAdmin.delete(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, jobSessionId)).catch(() => {});
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.id, jobPlanId)).catch(() => {});
  await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.id, jobApplicationId)).catch(() => {});
  await dbAdmin.delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, [ownerCandidateId, peerCandidateId])).catch(() => {});
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.id, jobId)).catch(() => {});
  await dbAdmin.delete(candidatesTable)
    .where(inArray(candidatesTable.id, [ownerCandidateId, peerCandidateId])).catch(() => {});
  await dbAdmin.delete(usersTable)
    .where(inArray(usersTable.id, [ownerUserId, peerUserId, staffUserId, platformUserId])).catch(() => {});
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId)).catch(() => {});
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({
    id: tenantId, name: "Development Firewall Tenant", slug: tenantId, plan: "enterprise",
  });
  await dbAdmin.insert(usersTable).values([
    { id: ownerUserId, tenantId, email: `${ownerUserId}@test.invalid`, name: "Owner", passwordHash: "x", role: "candidate" },
    { id: peerUserId, tenantId, email: `${peerUserId}@test.invalid`, name: "Peer", passwordHash: "x", role: "candidate" },
    { id: staffUserId, tenantId, email: `${staffUserId}@test.invalid`, name: "Staff", passwordHash: "x", role: "tenant_admin" },
    { id: platformUserId, tenantId, email: `${platformUserId}@test.invalid`, name: "Platform", passwordHash: "x", role: "platform_admin" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    { id: ownerCandidateId, tenantId, userId: ownerUserId, firstName: "Private", lastName: "Owner", email: `${ownerCandidateId}@test.invalid`, pool: "tenant" },
    { id: peerCandidateId, tenantId, userId: peerUserId, firstName: "Private", lastName: "Peer", email: `${peerCandidateId}@test.invalid`, pool: "tenant" },
  ]);
  await dbAdmin.insert(jobsTable).values({
    id: jobId, tenantId, title: "Scoped Job", description: "Job scope", status: "active",
  });
  await dbAdmin.insert(candidateCareerProfilesTable).values({
    candidateId: ownerCandidateId,
    aiSummary: "PRIVATE BASELINE SUMMARY",
    transcriptEnglish: "PRIVATE BASELINE TRANSCRIPT",
    baselineConversation: [{ role: "user", content: "PRIVATE BASELINE ANSWER" }],
    recordingUrl: "/recordings/11111111-1111-1111-1111-111111111111/",
  } as any);
  await dbAdmin.insert(prepSessionsTable).values({
    id: prepSessionId, tenantId, candidateId: ownerCandidateId, jobId,
    mode: "quick", status: "active", questions: ["PRIVATE PRACTICE QUESTION"],
    answers: [{ questionId: "q1", answer: "PRIVATE PRACTICE ANSWER" }],
    totalQuestions: 1, questionsAnswered: 1,
  });
  await dbAdmin.insert(interviewPlansTable).values({
    id: jobPlanId, tenantId, jobId, title: "Scoped plan", questions: [],
  });
  await dbAdmin.insert(applicationsTable).values({
    id: jobApplicationId, tenantId, jobId, candidateId: ownerCandidateId, stage: "applied",
  });
  await dbAdmin.insert(interviewSessionsTable).values([
    {
      id: jobSessionId, tenantId, candidateId: ownerCandidateId, applicationId: jobApplicationId, planId: jobPlanId,
      status: "completed", totalQuestions: 1,
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
  const owner = await request("GET", `/candidates/${ownerCandidateId}/career-profile`, token(ownerUserId, "candidate"));
  assert.equal(owner.status, 200);
  assert.equal(owner.body.exists, true);
  assert.equal(owner.body.transcriptEnglish, "PRIVATE BASELINE TRANSCRIPT");

  for (const bearer of [token(peerUserId, "candidate"), token(staffUserId, "tenant_admin"), token(platformUserId, "platform_admin")]) {
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
    "POST", "/prep/generate", token(staffUserId, "tenant_admin"),
    { candidateId: ownerCandidateId, jobId, mode: "quick" },
  );
  assert.equal(staffGenerate.status, 403);
});

test("baseline playback is denied to staff while job-specific sessions remain visible", async () => {
  const staffPlayback = await request(
    "GET", `/portal/career-interview/recording-playback-url/${ownerCandidateId}`,
    token(platformUserId, "platform_admin"),
  );
  assert.equal(staffPlayback.status, 404);

  const staffRecording = await request(
    "GET", `/candidates/${ownerCandidateId}/career-recording`,
    token(staffUserId, "tenant_admin"),
  );
  assert.equal(staffRecording.status, 404);

  const sessions = await request("GET", "/interviews", token(platformUserId, "platform_admin"));
  assert.equal(sessions.status, 200);
  const ids = new Set(sessions.body.map((session: any) => session.id));
  assert.equal(ids.has(jobSessionId), true, "job-specific assessment remains operationally visible");
});