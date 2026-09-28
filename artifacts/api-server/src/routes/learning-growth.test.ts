import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  candidateCareerProfilesTable,
  candidateLearningProfilesTable,
  candidatesTable,
  dbAdmin,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { withTenantContext } from "../middlewares/withTenantContext";
import learningGrowthRouter from "./learning-growth";

const prefix = `learning_growth_${crypto.randomUUID().slice(0, 8)}_`;
const id = (suffix: string) => prefix + suffix;
const tenantOne = id("tenant_one");
const tenantTwo = id("tenant_two");
const candidateA = id("candidate_a");
const candidateB = id("candidate_b");
const candidateC = id("candidate_c");
const userA = id("user_a");
const userB = id("user_b");
const userC = id("user_c");
const recruiter = id("recruiter");
const tenantAdmin = id("tenant_admin");

const originalEnabled = process.env.LEARNING_PILOT_ENABLED;
const originalAllowlist = process.env.LEARNING_PILOT_CANDIDATE_IDS;
let server: Server | undefined;
let baseUrl = "";

const token = (userId: string, role: string, tenantId: string) =>
  issueToken({ userId, role, tenantId });

const validInterests = {
  revision: 0,
  careerAreas: ["software_technology"],
  otherInterest: null,
  immediateRoles: ["Customer support"],
  educationStage: "graduating",
  discipline: "Computer science",
  graduationYear: 2027,
  learningPriorities: ["first_job", "communication"],
  preferredLanguage: "English",
  accessibilityPreferences: null,
  startTiming: "now",
};

async function request(method: string, path: string, authToken?: string, body?: unknown) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody: any = await response.json().catch(() => null);
  return {
    status: response.status,
    body: responseBody,
    cacheControl: response.headers.get("cache-control"),
  };
}

async function cleanup() {
  await dbAdmin.delete(candidateLearningProfilesTable)
    .where(inArray(candidateLearningProfilesTable.candidateId, [candidateA, candidateB, candidateC]))
    .catch(() => {});
  await dbAdmin.delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, [candidateA, candidateB, candidateC]))
    .catch(() => {});
  await dbAdmin.delete(candidatesTable)
    .where(inArray(candidatesTable.id, [candidateA, candidateB, candidateC]))
    .catch(() => {});
  await dbAdmin.delete(usersTable)
    .where(inArray(usersTable.id, [userA, userB, userC, recruiter, tenantAdmin]))
    .catch(() => {});
  await dbAdmin.delete(tenantsTable)
    .where(inArray(tenantsTable.id, [tenantOne, tenantTwo]))
    .catch(() => {});
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: tenantOne, name: "Learning Tenant One", slug: tenantOne, plan: "enterprise" },
    { id: tenantTwo, name: "Learning Tenant Two", slug: tenantTwo, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: userA, tenantId: tenantOne, email: `${userA}@test.invalid`, name: "Candidate A", passwordHash: "x", role: "candidate" },
    { id: userB, tenantId: tenantOne, email: `${userB}@test.invalid`, name: "Candidate B", passwordHash: "x", role: "candidate" },
    { id: userC, tenantId: tenantTwo, email: `${userC}@test.invalid`, name: "Candidate C", passwordHash: "x", role: "candidate" },
    { id: recruiter, tenantId: tenantOne, email: `${recruiter}@test.invalid`, name: "Recruiter", passwordHash: "x", role: "recruiter" },
    { id: tenantAdmin, tenantId: tenantOne, email: `${tenantAdmin}@test.invalid`, name: "Admin", passwordHash: "x", role: "tenant_admin" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    { id: candidateA, tenantId: tenantOne, userId: userA, firstName: "Candidate", lastName: "A", email: `${candidateA}@test.invalid`, pool: "tenant" },
    { id: candidateB, tenantId: tenantOne, userId: userB, firstName: "Candidate", lastName: "B", email: `${candidateB}@test.invalid`, pool: "tenant" },
    { id: candidateC, tenantId: tenantTwo, userId: userC, firstName: "Candidate", lastName: "C", email: `${candidateC}@test.invalid`, pool: "tenant" },
  ]);
  await dbAdmin.insert(candidateCareerProfilesTable).values([
    { id: id("profile_a"), candidateId: candidateA, baselineInterviewCompleted: false, careerGoal3yr: "Original three-year suggestion", careerGoal5yr: "Original five-year suggestion" },
    { id: id("profile_b"), candidateId: candidateB, baselineInterviewCompleted: false },
    { id: id("profile_c"), candidateId: candidateC, baselineInterviewCompleted: false },
  ]);

  const app = express();
  app.use(express.json());
  app.use(withTenantContext);
  app.use(learningGrowthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      resolve();
    });
  });
});

after(async () => {
  if (originalEnabled === undefined) delete process.env.LEARNING_PILOT_ENABLED;
  else process.env.LEARNING_PILOT_ENABLED = originalEnabled;
  if (originalAllowlist === undefined) delete process.env.LEARNING_PILOT_CANDIDATE_IDS;
  else process.env.LEARNING_PILOT_CANDIDATE_IDS = originalAllowlist;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await cleanup();
});

test("graduate learning pilot enforces owner privacy, gating, concurrency, canonical goals, and conservative course targeting", async () => {
  const tokenA = token(userA, "candidate", tenantOne);
  const tokenB = token(userB, "candidate", tenantOne);
  const tokenC = token(userC, "candidate", tenantTwo);

  process.env.LEARNING_PILOT_ENABLED = "false";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = "*";
  const unauthenticated = await request("GET", "/portal/learning-growth");
  assert.equal(unauthenticated.status, 401);
  const recruiterRead = await request("GET", "/portal/learning-growth", token(recruiter, "recruiter", tenantOne));
  assert.equal(recruiterRead.status, 403);
  const adminRead = await request("GET", "/portal/learning-growth", token(tenantAdmin, "tenant_admin", tenantOne));
  assert.equal(adminRead.status, 403);

  const off = await request("GET", "/portal/learning-growth", tokenA);
  assert.equal(off.status, 200);
  assert.equal(off.cacheControl, "private, no-store");
  assert.deepEqual(off.body, {
    available: false,
    stage: "unavailable",
    revision: 0,
    baseline: { completed: false, completedAt: null },
    interests: null,
    goals: { immediateGoal: "", careerGoal3yr: "", careerGoal5yr: "", confirmedAt: null },
    plan: null,
  });
  assert.equal((await request("PUT", "/portal/learning-growth/interests", tokenA, validInterests)).status, 404);
  assert.equal((await request("PUT", "/portal/learning-growth/goals", tokenA, {
    revision: 0, immediateGoal: "Find a role", careerGoal3yr: "Grow", careerGoal5yr: "Lead",
  })).status, 404);

  process.env.LEARNING_PILOT_ENABLED = "true";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = candidateA;
  assert.equal((await request("GET", "/portal/learning-growth", tokenB)).body.available, false, "empty/nonmatching allowlist denies access");
  const initial = await request("GET", "/portal/learning-growth", tokenA);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.stage, "interests");
  assert.equal(initial.body.revision, 0);
  assert.equal(initial.body.goals.careerGoal3yr, "Original three-year suggestion");
  assert.equal(initial.body.baseline.completedAt, null, "no completion timestamp is fabricated");

  const unknownInterestField = await request("PUT", "/portal/learning-growth/interests", tokenA, {
    ...validInterests,
    baselineInterviewCompleted: true,
  });
  assert.equal(unknownInterestField.status, 400, "caller cannot bypass baseline with a mutation field");
  const invalidOther = await request("PUT", "/portal/learning-growth/interests", tokenA, {
    ...validInterests,
    careerAreas: ["other"],
    otherInterest: "  ",
  });
  assert.equal(invalidOther.status, 400);
  const nonIntegerRevision = await request("PUT", "/portal/learning-growth/interests", tokenA, {
    ...validInterests,
    revision: 0.5,
  });
  assert.equal(nonIntegerRevision.status, 400);
  const blankRole = await request("PUT", "/portal/learning-growth/interests", tokenA, {
    ...validInterests,
    immediateRoles: ["   "],
  });
  assert.equal(blankRole.status, 400);

  const saved = await request("PUT", "/portal/learning-growth/interests", tokenA, {
    ...validInterests,
    immediateRoles: [" Customer support ", "Customer support"],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal(saved.body.stage, "baseline");
  assert.deepEqual(saved.body.interests.immediateRoles, ["Customer support"]);
  const staleInsert = await request("PUT", "/portal/learning-growth/interests", tokenA, validInterests);
  assert.equal(staleInsert.status, 409);

  const bypassGoal = await request("PUT", "/portal/learning-growth/goals", tokenA, {
    revision: 1,
    immediateGoal: "Start in support",
    careerGoal3yr: "Become a support specialist",
    careerGoal5yr: "Lead a support team",
    baselineInterviewCompleted: true,
  });
  assert.equal(bypassGoal.status, 400);
  const whitespaceGoal = await request("PUT", "/portal/learning-growth/goals", tokenA, {
    revision: 1, immediateGoal: " ", careerGoal3yr: "Grow", careerGoal5yr: "Lead",
  });
  assert.equal(whitespaceGoal.status, 400);
  const prerequisite = await request("PUT", "/portal/learning-growth/goals", tokenA, {
    revision: 1,
    immediateGoal: "Start in support",
    careerGoal3yr: "Become a support specialist",
    careerGoal5yr: "Lead a support team",
  });
  assert.equal(prerequisite.status, 409, "saved interests cannot substitute for authoritative baseline completion");

  await dbAdmin.update(candidateCareerProfilesTable)
    .set({ baselineInterviewCompleted: true })
    .where(eq(candidateCareerProfilesTable.candidateId, candidateA));
  const confirmed = await request("PUT", "/portal/learning-growth/goals", tokenA, {
    revision: 1,
    immediateGoal: "  Start in support  ",
    careerGoal3yr: "  Become a support specialist  ",
    careerGoal5yr: "  Lead a support team  ",
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.stage, "ready");
  assert.equal(confirmed.body.revision, 2);
  assert.equal(confirmed.body.goals.immediateGoal, "Start in support");
  assert.ok(confirmed.body.goals.confirmedAt);
  assert.equal(confirmed.body.plan.summary.includes("software_technology"), false);
  assert.equal(confirmed.body.plan.summary.includes("first_job"), false);
  assert.equal(confirmed.body.plan.startingPointNote.includes("reviewed"), false);
  assert.deepEqual(
    confirmed.body.plan.plannedCourses.map((course: { title: string }) => course.title),
    ["Customer Support Communication Foundations", "Customer Support Communication in Practice"],
    "an exact normalized customer-support immediate role is eligible",
  );
  const [canonical] = await dbAdmin.select({
    three: candidateCareerProfilesTable.careerGoal3yr,
    five: candidateCareerProfilesTable.careerGoal5yr,
  }).from(candidateCareerProfilesTable).where(eq(candidateCareerProfilesTable.candidateId, candidateA));
  assert.deepEqual(canonical, { three: "Become a support specialist", five: "Lead a support team" });

  const staleGoal = await request("PUT", "/portal/learning-growth/goals", tokenA, {
    revision: 1, immediateGoal: "Different", careerGoal3yr: "Different", careerGoal5yr: "Different",
  });
  assert.equal(staleGoal.status, 409);

  await dbAdmin.update(candidateCareerProfilesTable).set({
    careerGoal3yr: "Edited in the existing career profile",
  }).where(eq(candidateCareerProfilesTable.candidateId, candidateA));
  const invalidated = await request("GET", "/portal/learning-growth", tokenA);
  assert.equal(invalidated.body.stage, "goals");
  assert.equal(invalidated.body.goals.confirmedAt, null);
  assert.equal(invalidated.body.plan, null, "later canonical career-profile edits invalidate confirmation");
  const reconfirmed = await request("PUT", "/portal/learning-growth/goals", tokenA, {
    revision: 2,
    immediateGoal: "Start in support",
    careerGoal3yr: "Edited in the existing career profile",
    careerGoal5yr: "Lead a support team",
  });
  assert.equal(reconfirmed.status, 200);
  assert.equal(reconfirmed.body.revision, 3);

  const softwareOnly = await request("PUT", "/portal/learning-growth/interests", tokenA, {
    ...validInterests,
    revision: 3,
    immediateRoles: ["Backend developer"],
  });
  assert.equal(softwareOnly.status, 200);
  assert.equal(softwareOnly.body.stage, "ready");
  assert.deepEqual(softwareOnly.body.plan.plannedCourses, [], "software-only interest is never steered to support courses");

  const explicitCustomerService = await request("PUT", "/portal/learning-growth/interests", tokenA, {
    ...validInterests,
    revision: 4,
    careerAreas: ["customer_service"],
    immediateRoles: [],
  });
  assert.equal(explicitCustomerService.status, 200);
  assert.equal(explicitCustomerService.body.plan.plannedCourses.length, 2);
  assert.ok(explicitCustomerService.body.plan.plannedCourses.every((course: { status: string }) => course.status === "planned"));
  assert.ok(explicitCustomerService.body.plan.plannedCourses.every((course: { description: string }) => course.description.includes("not yet launchable")));
  const persisted = await request("GET", "/portal/learning-growth", tokenA);
  assert.equal(persisted.body.revision, 5);
  assert.deepEqual(persisted.body.interests.careerAreas, ["customer_service"]);

  process.env.LEARNING_PILOT_CANDIDATE_IDS = [candidateA, candidateB, candidateC].join(",");
  const isolatedInterests = (immediateRole: string) => ({
    careerAreas: ["software_technology"],
    otherInterest: null,
    immediateRoles: [immediateRole],
    educationStage: "graduating",
    discipline: "Computer science",
    graduationYear: 2027,
    learningPriorities: ["first_job", "communication"],
    preferredLanguage: "English",
    accessibilityPreferences: null,
    startTiming: "now",
  });
  await dbAdmin.insert(candidateLearningProfilesTable).values([
    {
      id: id("learning_b"),
      candidateId: candidateB,
      tenantId: tenantOne,
      revision: 7,
      interests: isolatedInterests("Data analyst"),
    },
    {
      id: id("learning_c"),
      candidateId: candidateC,
      tenantId: tenantTwo,
      revision: 9,
      interests: isolatedInterests("Operations analyst"),
    },
  ]);
  const sameTenantOtherOwner = await request("GET", "/portal/learning-growth", tokenB);
  assert.equal(sameTenantOtherOwner.body.revision, 7);
  assert.deepEqual(sameTenantOtherOwner.body.interests.immediateRoles, ["Data analyst"]);
  assert.notDeepEqual(sameTenantOtherOwner.body.interests, persisted.body.interests);
  const differentTenantOtherOwner = await request("GET", "/portal/learning-growth", tokenC);
  assert.equal(differentTenantOtherOwner.body.revision, 9);
  assert.deepEqual(differentTenantOtherOwner.body.interests.immediateRoles, ["Operations analyst"]);
  assert.equal((await request("GET", "/portal/learning-growth", tokenA)).body.revision, 5);
});