/**
 * Candidate introduction lifecycle contract.
 *
 * Exercises the real introduction router over HTTP so the candidate-session
 * resolver, strict body validation, optimistic version token, and employer
 * approved-only projection are all covered together.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  candidateIntroductionsTable,
  candidatesTable,
  dbAdmin,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import candidateIntroductionRouter from "./candidate-introduction";

const P = `intro_lifecycle_${crypto.randomUUID().slice(0, 8)}_`;
const id = (value: string) => P + value;
const tenantId = id("tenant");
const ownerUserId = id("candidate_user");
const adminUserId = id("tenant_admin");
const candidateId = id("candidate");

let server: Server | undefined;
let baseUrl = "";

const candidateToken = () => issueToken({ userId: ownerUserId, role: "candidate", tenantId });
const adminToken = () => issueToken({ userId: adminUserId, role: "tenant_admin", tenantId });

async function request(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const firstDraft = {
  summary: "I lead difficult engineering work from ambiguity through measurable delivery.",
  strengths: [{ title: "Systems leadership", evidence: "Led the recovery of a failing service and restored reliability." }],
  achievements: [{ text: "Reduced incident volume by 40% across a cross-functional program." }],
  careerDirection: "Engineering leadership",
  rolePreferences: "Platform engineering leadership",
  availability: "Open to conversations this quarter",
};
const editedDraft = {
  ...firstDraft,
  summary: "I build reliable platforms and lead teams through high-stakes delivery.",
};

async function cleanup() {
  await dbAdmin.delete(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, candidateId)).catch(() => {});
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, candidateId)).catch(() => {});
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, [ownerUserId, adminUserId])).catch(() => {});
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId)).catch(() => {});
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({
    id: tenantId, name: "Introduction Lifecycle Tenant", slug: tenantId, plan: "enterprise",
  });
  await dbAdmin.insert(usersTable).values([
    { id: ownerUserId, tenantId, email: `${ownerUserId}@test.invalid`, name: "Candidate", passwordHash: "x", role: "candidate" },
    { id: adminUserId, tenantId, email: `${adminUserId}@test.invalid`, name: "Tenant Admin", passwordHash: "x", role: "tenant_admin" },
  ]);
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId, tenantId, userId: ownerUserId, firstName: "Intro", lastName: "Candidate",
    email: `${candidateId}@test.invalid`, pool: "tenant",
  });

  const app = express();
  app.use(express.json());
  app.use(candidateIntroductionRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server!.address() as { port: number };
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await cleanup();
});

test("candidate introduction follows private draft, approval, stale-version, edit, and withdrawal lifecycle", async () => {
  const ownEmpty = await request("GET", "/portal/introduction", candidateToken());
  assert.equal(ownEmpty.status, 200);
  assert.deepEqual(ownEmpty.body, {
    exists: false, candidateId, status: "draft", summary: "", strengths: [], achievements: [],
    careerDirection: null, rolePreferences: null, availability: null,
    approvedAt: null, withdrawnAt: null, version: null,
  });

  const adminPut = await request("PUT", "/portal/introduction", adminToken(), firstDraft);
  assert.equal(adminPut.status, 401, "staff cannot write a candidate-owned introduction");

  const invalidPrivateField = await request("PUT", "/portal/introduction", candidateToken(), {
    ...firstDraft, privateTranscript: "must never be accepted",
  });
  assert.equal(invalidPrivateField.status, 400, "strict body rejects unknown/private fields");

  const saved = await request("PUT", "/portal/introduction", candidateToken(), firstDraft);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status, "draft");
  assert.ok(saved.body.version, "save returns an optimistic-concurrency token");

  const employerDraft = await request("GET", `/candidates/${candidateId}/introduction`, adminToken());
  assert.equal(employerDraft.status, 404, "draft introduction is never employer-readable");

  /* The browser flow reads immediately before it approves. This exact version
     must be accepted; otherwise a timestamp serialization/precision mismatch
     would make the public UI race itself into a 409. */
  const current = await request("GET", "/portal/introduction", candidateToken());
  assert.equal(current.status, 200);
  assert.equal(current.body.status, "draft");
  const currentVersion = current.body.version as string;
  assert.ok(currentVersion);

  const approved = await request("POST", "/portal/introduction/approve", candidateToken(), { version: currentVersion });
  assert.equal(approved.status, 200, `immediate GET version must approve: ${JSON.stringify(approved.body)}`);
  assert.equal(approved.body.status, "approved");

  const employerApproved = await request("GET", `/candidates/${candidateId}/introduction`, adminToken());
  assert.equal(employerApproved.status, 200);
  assert.equal(employerApproved.body.exists, true);
  assert.equal(employerApproved.body.summary, firstDraft.summary);
  assert.equal("status" in employerApproved.body, false, "employer response is the approved public projection only");

  const edited = await request("PUT", "/portal/introduction", candidateToken(), editedDraft);
  assert.equal(edited.status, 200);
  assert.equal(edited.body.status, "draft", "any edit revokes prior approval");
  assert.equal(edited.body.approvedAt, null);

  const employerAfterEdit = await request("GET", `/candidates/${candidateId}/introduction`, adminToken());
  assert.equal(employerAfterEdit.status, 404, "an edited draft is hidden until candidate re-approves");

  const staleApprove = await request("POST", "/portal/introduction/approve", candidateToken(), { version: currentVersion });
  assert.equal(staleApprove.status, 409, "approval must reject the pre-edit version");

  const latest = await request("GET", "/portal/introduction", candidateToken());
  const latestApprove = await request("POST", "/portal/introduction/approve", candidateToken(), { version: latest.body.version });
  assert.equal(latestApprove.status, 200);
  assert.equal(latestApprove.body.status, "approved");

  const withdrawn = await request("POST", "/portal/introduction/withdraw", candidateToken());
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, "withdrawn");
  assert.equal(withdrawn.body.approvedAt, null);

  const employerWithdrawn = await request("GET", `/candidates/${candidateId}/introduction`, adminToken());
  assert.equal(employerWithdrawn.status, 404, "withdrawn introduction is never employer-readable");
});