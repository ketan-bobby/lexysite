import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  candidateCareerProfilesTable,
  candidateLearningAssessmentTasksTable,
  candidateLearningAssessmentsTable,
  candidateLearningEnrollmentsTable,
  candidateLearningProfilesTable,
  candidateLearningRewardLedgerTable,
  applicationsTable,
  candidateJobIntelligenceTable,
  interviewSessionsTable,
  candidatesTable,
  dbAdmin,
  tenantsTable,
  usersTable,
  pool,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { getAssessmentDefinition } from "../lib/learning-assessments/catalog";
import { withTenantContext } from "../middlewares/withTenantContext";
import learningGrowthRouter from "./learning-growth";

const prefix = `learning_assessments_${crypto.randomUUID().slice(0, 8)}_`;
const id = (suffix: string) => prefix + suffix;
const tenantA = id("tenant_a");
const tenantB = id("tenant_b");
const candidateA = id("candidate_a");
const candidateB = id("candidate_b");
const candidateC = id("candidate_c");
const incomplete = id("incomplete");
const userA = id("user_a");
const userB = id("user_b");
const userC = id("user_c");
const userIncomplete = id("incomplete_user");
const staff = id("staff");
const courseId = "support-communication-foundations";
const originalEnabled = process.env.LEARNING_PILOT_ENABLED;
const originalAllowlist = process.env.LEARNING_PILOT_CANDIDATE_IDS;
let server: Server | undefined;
let baseUrl = "";

const token = (userId: string, role: string, tenantId: string) =>
  issueToken({ userId, role, tenantId });

async function request(method: string, path: string, authToken?: string, body?: unknown) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function cleanup() {
  const candidates = [candidateA, candidateB, candidateC, incomplete];
  await dbAdmin
    .delete(candidateLearningRewardLedgerTable)
    .where(inArray(candidateLearningRewardLedgerTable.candidateId, candidates))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningAssessmentTasksTable)
    .where(inArray(candidateLearningAssessmentTasksTable.candidateId, candidates))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningAssessmentsTable)
    .where(inArray(candidateLearningAssessmentsTable.candidateId, candidates))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningEnrollmentsTable)
    .where(inArray(candidateLearningEnrollmentsTable.candidateId, candidates))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningProfilesTable)
    .where(inArray(candidateLearningProfilesTable.candidateId, candidates))
    .catch(() => {});
  await dbAdmin
    .delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, candidates))
    .catch(() => {});
  await dbAdmin
    .delete(candidatesTable)
    .where(inArray(candidatesTable.id, candidates))
    .catch(() => {});
  await dbAdmin
    .delete(usersTable)
    .where(inArray(usersTable.id, [userA, userB, userC, userIncomplete, staff]))
    .catch(() => {});
  await dbAdmin
    .delete(tenantsTable)
    .where(inArray(tenantsTable.id, [tenantA, tenantB]))
    .catch(() => {});
}

const interests = {
  careerAreas: ["customer_service"],
  otherInterest: null,
  immediateRoles: [],
  educationStage: "graduated",
  discipline: null,
  graduationYear: null,
  learningPriorities: ["communication"],
  preferredLanguage: null,
  accessibilityPreferences: null,
  startTiming: "now",
};

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: tenantA, name: "Assessment Tenant A", slug: tenantA, plan: "enterprise" },
    { id: tenantB, name: "Assessment Tenant B", slug: tenantB, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: userA,
      tenantId: tenantA,
      email: `${userA}@test.invalid`,
      name: "Assessment A",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userB,
      tenantId: tenantB,
      email: `${userB}@test.invalid`,
      name: "Assessment B",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userC,
      tenantId: tenantA,
      email: `${userC}@test.invalid`,
      name: "Assessment C",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userIncomplete,
      tenantId: tenantA,
      email: `${userIncomplete}@test.invalid`,
      name: "Incomplete",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: staff,
      tenantId: tenantA,
      email: `${staff}@test.invalid`,
      name: "Staff",
      passwordHash: "x",
      role: "tenant_admin",
    },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    {
      id: candidateA,
      tenantId: tenantA,
      userId: userA,
      firstName: "Assessment",
      lastName: "A",
      email: `${candidateA}@test.invalid`,
      pool: "tenant",
    },
    {
      id: candidateB,
      tenantId: tenantB,
      userId: userB,
      firstName: "Assessment",
      lastName: "B",
      email: `${candidateB}@test.invalid`,
      pool: "tenant",
    },
    {
      id: candidateC,
      tenantId: tenantA,
      userId: userC,
      firstName: "Assessment",
      lastName: "C",
      email: `${candidateC}@test.invalid`,
      pool: "tenant",
    },
    {
      id: incomplete,
      tenantId: tenantA,
      userId: userIncomplete,
      firstName: "Incomplete",
      lastName: "Course",
      email: `${incomplete}@test.invalid`,
      pool: "tenant",
    },
  ]);
  await dbAdmin.insert(candidateCareerProfilesTable).values([
    {
      id: id("career_a"),
      candidateId: candidateA,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support",
      careerGoal5yr: "Support lead",
    },
    {
      id: id("career_b"),
      candidateId: candidateB,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support",
      careerGoal5yr: "Support lead",
    },
    {
      id: id("career_c"),
      candidateId: candidateC,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support",
      careerGoal5yr: "Support lead",
    },
    {
      id: id("career_i"),
      candidateId: incomplete,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support",
      careerGoal5yr: "Support lead",
    },
  ]);
  await dbAdmin.insert(candidateLearningProfilesTable).values(
    [candidateA, candidateB, candidateC, incomplete].map((candidateId, index) => ({
      id: id(`learning_${index}`),
      candidateId,
      tenantId: candidateId === candidateB ? tenantB : tenantA,
      interests,
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
    })),
  );
  const now = new Date();
  await dbAdmin.insert(candidateLearningEnrollmentsTable).values([
    {
      id: id("enrollment_a"),
      candidateId: candidateA,
      tenantId: tenantA,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "completed",
      enrolledAt: now,
      completedAt: now,
    },
    {
      id: id("enrollment_b"),
      candidateId: candidateB,
      tenantId: tenantB,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "completed",
      enrolledAt: now,
      completedAt: now,
    },
    {
      id: id("enrollment_c"),
      candidateId: candidateC,
      tenantId: tenantA,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "completed",
      enrolledAt: now,
      completedAt: now,
    },
    {
      id: id("enrollment_i"),
      candidateId: incomplete,
      tenantId: tenantA,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "in_progress",
      enrolledAt: now,
    },
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
  process.env.LEARNING_PILOT_ENABLED = "true";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = [candidateA, candidateB, candidateC, incomplete].join(
    ",",
  );
});

after(async () => {
  if (originalEnabled === undefined) delete process.env.LEARNING_PILOT_ENABLED;
  else process.env.LEARNING_PILOT_ENABLED = originalEnabled;
  if (originalAllowlist === undefined) delete process.env.LEARNING_PILOT_CANDIDATE_IDS;
  else process.env.LEARNING_PILOT_CANDIDATE_IDS = originalAllowlist;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await cleanup();
});

test("assessment owner flow saves drafts, rejects stale/submitted writes, freezes report, and stays isolated", async () => {
  const owner = token(userA, "candidate", tenantA);
  const otherTenant = token(userB, "candidate", tenantB);
  const staffToken = token(staff, "tenant_admin", tenantA);
  const incompleteToken = token(userIncomplete, "candidate", tenantA);
  const definition = getAssessmentDefinition(courseId, "voice");
  assert.ok(definition);

  process.env.LEARNING_PILOT_ENABLED = "false";
  const off = await request("GET", "/portal/learning-growth/assessments", owner);
  assert.deepEqual(off.body, { available: false, unlockedCourses: [], assessments: [] });
  process.env.LEARNING_PILOT_ENABLED = "true";

  assert.equal(
    (await request("POST", "/portal/learning-growth/assessments", incompleteToken, { courseId }))
      .status,
    403,
  );
  assert.equal(
    (await request("GET", "/portal/learning-growth/assessments", staffToken)).status,
    403,
  );
  assert.equal(
    (await request("GET", "/portal/learning-growth/assessments", otherTenant)).body.assessments
      .length,
    0,
  );

  const started = await request("POST", "/portal/learning-growth/assessments", owner, { courseId });
  assert.equal(started.status, 200);
  const assessmentId = started.body.summary.id;
  const first = definition.tasks[0];
  const draft = await request(
    "PUT",
    `/portal/learning-growth/assessments/${assessmentId}/tasks/${first.key}`,
    owner,
    {
      revision: 0,
      response: "A private draft response",
      action: "save_draft",
    },
  );
  assert.equal(draft.status, 200);
  assert.equal(
    draft.body.tasks.find((task: any) => task.key === first.key).progress.status,
    "draft",
  );
  assert.equal(
    (await request("GET", `/portal/learning-growth/assessments/${assessmentId}`, owner)).status,
    200,
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/assessments/${assessmentId}/tasks/${first.key}`,
        owner,
        {
          revision: 0,
          response: "stale overwrite",
          action: "save_draft",
        },
      )
    ).status,
    409,
  );

  const answer =
    "I acknowledge the concern, check the relevant details, confirm the next step, and provide a careful update.";
  let latest = draft.body;
  for (const task of definition.tasks) {
    const progress = latest.tasks.find((item: any) => item.key === task.key)?.progress;
    if (progress?.status === "submitted") continue;
    latest = (
      await request(
        "PUT",
        `/portal/learning-growth/assessments/${assessmentId}/tasks/${task.key}`,
        owner,
        {
          revision: progress?.revision ?? 0,
          response: answer,
          action: "submit",
        },
      )
    ).body;
  }
  assert.equal(latest.summary.status, "completed");
  const report = await request(
    "GET",
    `/portal/learning-growth/assessments/${assessmentId}/report`,
    owner,
  );
  assert.equal(report.status, 200);
  assert.equal(report.body.comparison.available, false);
  assert.equal(
    report.body.comparison.reason,
    "The initial career baseline did not capture a comparable structured task, so this report shows current evidence only.",
  );
  assert.ok(
    report.body.recommendations.every(
      (item: any) => item.lessonId && item.courseId && item.lessonTitle && item.reason,
    ),
  );
  assert.equal("percentage" in report.body, false);
  assert.equal("pass" in report.body, false);
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.candidateId, candidateA))
    ).length,
    0,
  );
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.candidateId, candidateA))
    ).length,
    0,
  );
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(candidateJobIntelligenceTable)
        .where(eq(candidateJobIntelligenceTable.candidateId, candidateA))
    ).length,
    0,
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/assessments/${assessmentId}/tasks/${first.key}`,
        owner,
        {
          revision: 1,
          response: answer,
          action: "submit",
        },
      )
    ).status,
    409,
  );

  const frozen = JSON.stringify(report.body);
  await dbAdmin
    .delete(candidateLearningAssessmentTasksTable)
    .where(
      and(
        eq(candidateLearningAssessmentTasksTable.assessmentId, assessmentId),
        eq(candidateLearningAssessmentTasksTable.candidateId, candidateA),
        eq(candidateLearningAssessmentTasksTable.tenantId, tenantA),
      ),
    );
  const afterTaskDeletion = await request(
    "GET",
    `/portal/learning-growth/assessments/${assessmentId}/report`,
    owner,
  );
  assert.equal(JSON.stringify(afterTaskDeletion.body), frozen);

  const [candidate] = await dbAdmin
    .select({
      applicationId: candidateLearningAssessmentsTable.id,
    })
    .from(candidateLearningAssessmentsTable)
    .where(eq(candidateLearningAssessmentsTable.id, assessmentId));
  assert.equal(candidate.applicationId, assessmentId);
});

test("assessment routes enforce authentication, ownership, strict inputs, and idempotent starts", async () => {
  const owner = token(userC, "candidate", tenantA);
  const wrongRole = token(staff, "tenant_admin", tenantA);
  const endpoint = "/portal/learning-growth/assessments";
  for (const [label, authToken, expected] of [
    ["unauthenticated", undefined, 401],
    ["wrong role", wrongRole, 403],
  ] as const) {
    assert.equal((await request("GET", endpoint, authToken)).status, expected, label);
  }
  for (const [body, expected] of [
    [{ courseId: "unknown-course" }, 403],
    [{ courseId: "" }, 400],
    [{ courseId, extra: true }, 400],
  ] as const) {
    assert.equal((await request("POST", endpoint, owner, body)).status, expected);
  }
  const starts = await Promise.all(
    Array.from({ length: 8 }, () => request("POST", endpoint, owner, { courseId })),
  );
  assert.ok(starts.every((result) => result.status === 200));
  const ids = new Set(starts.map((result) => result.body.summary.id));
  assert.equal(ids.size, 1, "concurrent starts must resume one draft");
  const rows = await dbAdmin
    .select()
    .from(candidateLearningAssessmentsTable)
    .where(
      and(
        eq(candidateLearningAssessmentsTable.candidateId, candidateC),
        eq(candidateLearningAssessmentsTable.tenantId, tenantA),
        eq(candidateLearningAssessmentsTable.courseId, courseId),
      ),
    );
  assert.equal(rows.length, 1);
});

test("assessment task lifecycle validates without mutation and freezes first completion", async () => {
  const owner = token(userC, "candidate", tenantA);
  const otherCandidate = token(userA, "candidate", tenantA);
  await dbAdmin
    .delete(candidateLearningAssessmentTasksTable)
    .where(eq(candidateLearningAssessmentTasksTable.candidateId, candidateC));
  await dbAdmin
    .delete(candidateLearningAssessmentsTable)
    .where(eq(candidateLearningAssessmentsTable.candidateId, candidateC));
  await dbAdmin
    .delete(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateC));
  const definition = getAssessmentDefinition(courseId, "voice");
  assert.ok(definition);
  const started = await request("POST", "/portal/learning-growth/assessments", owner, { courseId });
  const assessmentId = started.body.summary.id;
  const first = definition.tasks[0];
  const taskPath = `/portal/learning-growth/assessments/${assessmentId}/tasks/${first.key}`;
  const snapshotBefore = await request(
    "GET",
    `/portal/learning-growth/assessments/${assessmentId}`,
    owner,
  );
  for (const body of [
    { revision: 0, response: "", action: "submit" },
    { revision: -1, response: "invalid", action: "save_draft" },
    { revision: 0, response: "valid", action: "save_draft", unknown: true },
  ]) {
    assert.equal((await request("PUT", taskPath, owner, body)).status, 400);
  }
  assert.deepEqual(
    (await request("GET", `/portal/learning-growth/assessments/${assessmentId}`, owner)).body,
    snapshotBefore.body,
  );
  assert.equal(
    (
      await request("PUT", `${taskPath}-unknown`, owner, {
        revision: 0,
        response: "valid",
        action: "save_draft",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("GET", `/portal/learning-growth/assessments/${assessmentId}`, otherCandidate))
      .status,
    404,
  );

  const answer =
    "I acknowledge the concern, check the order, ask a focused question, and confirm the next update.";
  let detail = (
    await request("PUT", taskPath, owner, {
      revision: 0,
      response: "private draft",
      action: "save_draft",
    })
  ).body;
  assert.equal(detail.tasks.find((task: any) => task.key === first.key).progress.status, "draft");
  const stale = await request("PUT", taskPath, owner, {
    revision: 0,
    response: "stale",
    action: "save_draft",
  });
  assert.equal(stale.status, 409);
  detail = (
    await request("PUT", taskPath, owner, { revision: 1, response: answer, action: "submit" })
  ).body;
  assert.equal(
    detail.tasks.find((task: any) => task.key === first.key).progress.status,
    "submitted",
  );
  assert.equal(
    (
      await request("PUT", taskPath, owner, {
        revision: 2,
        response: "mutate submitted",
        action: "save_draft",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/assessments/${assessmentId}/tasks/no-such-task`,
        owner,
        { revision: 0, response: answer, action: "submit" },
      )
    ).status,
    404,
  );

  const draftSecond = await request(
    "PUT",
    `/portal/learning-growth/assessments/${assessmentId}/tasks/${definition.tasks[1].key}`,
    owner,
    {
      revision: 0,
      response: answer,
      action: "save_draft",
    },
  );
  assert.equal(draftSecond.body.summary.status, "draft");
  const rewardBefore = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateC));
  const submittedSecond = await request(
    "PUT",
    `/portal/learning-growth/assessments/${assessmentId}/tasks/${definition.tasks[1].key}`,
    owner,
    { revision: 1, response: answer, action: "submit" },
  );
  assert.equal(submittedSecond.status, 200);
  const finalSubmissions = await Promise.all(
    definition.tasks
      .slice(2)
      .map((task) =>
        request(
          "PUT",
          `/portal/learning-growth/assessments/${assessmentId}/tasks/${task.key}`,
          owner,
          { revision: 0, response: answer, action: "submit" },
        ),
      ),
  );
  assert.deepEqual(
    finalSubmissions.map((result) => result.status).sort(),
    [200, 200],
    "concurrent final submissions must both commit",
  );
  const completed = await request(
    "GET",
    `/portal/learning-growth/assessments/${assessmentId}`,
    owner,
  );
  assert.equal(completed.body.summary.status, "completed");
  const report = await request(
    "GET",
    `/portal/learning-growth/assessments/${assessmentId}/report`,
    owner,
  );
  assert.equal(report.status, 200);
  const frozen = JSON.stringify(report.body);
  const rewardAfter = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateC));
  assert.equal(rewardAfter.length, rewardBefore.length + 1);
  assert.equal(new Set(rewardAfter.map((row) => row.eventKey)).size, rewardAfter.length);
  const assessmentRewards = rewardAfter.filter((row) => row.sourceType === "assessment");
  assert.equal(assessmentRewards.length, 1);
  assert.deepEqual(
    assessmentRewards[0] && {
      eventKey: assessmentRewards[0].eventKey,
      eventType: assessmentRewards[0].eventType,
      creditsDelta: assessmentRewards[0].creditsDelta,
    },
    {
      eventKey: `${candidateC}:assessment:first`,
      eventType: "first_completed_assessment",
      creditsDelta: 25,
    },
  );
  assert.equal(
    (
      await request("PUT", taskPath, owner, {
        revision: 2,
        response: "post completion",
        action: "submit",
      })
    ).status,
    409,
  );
  assert.equal(
    JSON.stringify(
      (await request("GET", `/portal/learning-growth/assessments/${assessmentId}/report`, owner))
        .body,
    ),
    frozen,
  );
  const repeated = await request("POST", endpointForStart(), owner, { courseId });
  assert.equal(repeated.status, 200);
  assert.notEqual(
    repeated.body.summary.id,
    assessmentId,
    "a completed assessment permits a repeat attempt",
  );
  assert.equal(repeated.body.summary.status, "draft");

  const rlsClient = await pool.connect();
  try {
    await rlsClient.query("SET ROLE lexy_app");
    const countForCandidate = async (tenantId: string, candidateId: string) => {
      await rlsClient.query(
        "SELECT set_config('app.allowed_tenant_ids', $1, false), set_config('app.current_tenant_id', $1, false), set_config('app.current_candidate_id', $2, false)",
        [tenantId, candidateId],
      );
      const parent = await rlsClient.query(
        "SELECT count(*) AS count FROM candidate_learning_assessments WHERE candidate_id = $1",
        [candidateC],
      );
      const tasks = await rlsClient.query(
        "SELECT count(*) AS count FROM candidate_learning_assessment_tasks WHERE candidate_id = $1",
        [candidateC],
      );
      const rewards = await rlsClient.query(
        "SELECT count(*) AS count FROM candidate_learning_reward_ledger WHERE candidate_id = $1",
        [candidateC],
      );
      return [parent, tasks, rewards].map((result) => Number(result.rows[0].count));
    };
    assert.deepEqual(await countForCandidate(tenantA, candidateC), [2, definition.tasks.length, 1]);
    assert.deepEqual(await countForCandidate(tenantA, candidateA), [0, 0, 0]);
    assert.deepEqual(await countForCandidate(tenantA, ""), [0, 0, 0]);
    assert.deepEqual(await countForCandidate(tenantB, candidateC), [0, 0, 0]);
  } finally {
    await rlsClient.query("DISCARD ALL").catch(() => {});
    await rlsClient.query("RESET ROLE").catch(() => {});
    rlsClient.release();
  }
});

function endpointForStart(): string {
  return "/portal/learning-growth/assessments";
}
