import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  candidateCareerProfilesTable,
  candidateLearningEnrollmentsTable,
  candidateLearningProfilesTable,
  candidateLearningCourseReviewLessonsTable,
  candidateLearningCourseReviewAttemptsTable,
  candidateLearningAssessmentsTable,
  candidateLearningVoiceCyclesTable,
  candidateLearningVoiceTurnsTable,
  candidateLearningRewardLedgerTable,
  candidatesTable,
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { getVoiceProgressForm } from "../lib/learning-voice-progress/catalog";
import { getLearningCourse } from "../lib/learning-courses/catalog";
import { withTenantContext } from "../middlewares/withTenantContext";
import learningGrowthRouter from "./learning-growth";

const prefix = `learning_voice_progress_${crypto.randomUUID().slice(0, 8)}_`;
const id = (suffix: string) => prefix + suffix;
const tenantA = id("tenant_a");
const tenantB = id("tenant_b");
const candidateA = id("candidate_a");
const candidateB = id("candidate_b");
const candidateOther = id("candidate_other");
const tenantRace = id("tenant_race");
const candidateRace = id("candidate_race");
const userRace = id("user_race");
const tenantAchievements = id("tenant_achievements");
const candidateAchievements = id("candidate_achievements");
const userAchievements = id("user_achievements");
const userA = id("user_a");
const userB = id("user_b");
const platformUser = id("platform_user");
const courseId = "support-communication-foundations";
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
let server: Server;
let baseUrl = "";

async function request(
  method: string,
  path: string,
  userId: string,
  tenantId: string,
  body?: unknown,
  role: string = "candidate",
) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${issueToken({ userId, role, tenantId })}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function unauthenticatedRequest(method: string, path: string, body?: unknown) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function cleanup() {
  const candidateIds = [
    candidateA,
    candidateB,
    candidateOther,
    candidateRace,
    candidateAchievements,
  ];
  await dbAdmin
    .delete(candidateLearningRewardLedgerTable)
    .where(inArray(candidateLearningRewardLedgerTable.candidateId, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningAssessmentsTable)
    .where(inArray(candidateLearningAssessmentsTable.candidateId, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningCourseReviewLessonsTable)
    .where(inArray(candidateLearningCourseReviewLessonsTable.candidateId, candidateIds));
  await dbAdmin
    .delete(candidateLearningCourseReviewAttemptsTable)
    .where(inArray(candidateLearningCourseReviewAttemptsTable.candidateId, candidateIds));
  await dbAdmin
    .delete(candidateLearningVoiceTurnsTable)
    .where(inArray(candidateLearningVoiceTurnsTable.candidateId, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningVoiceCyclesTable)
    .where(inArray(candidateLearningVoiceCyclesTable.candidateId, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningEnrollmentsTable)
    .where(inArray(candidateLearningEnrollmentsTable.candidateId, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningProfilesTable)
    .where(inArray(candidateLearningProfilesTable.candidateId, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(candidatesTable)
    .where(inArray(candidatesTable.id, candidateIds))
    .catch(() => {});
  await dbAdmin
    .delete(usersTable)
    .where(inArray(usersTable.id, [userA, userB, platformUser, userRace, userAchievements]))
    .catch(() => {});
  await dbAdmin
    .delete(tenantsTable)
    .where(inArray(tenantsTable.id, [tenantA, tenantB, tenantRace, tenantAchievements]))
    .catch(() => {});
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: tenantA, name: "Voice Progress A", slug: tenantA, plan: "enterprise" },
    { id: tenantB, name: "Voice Progress B", slug: tenantB, plan: "enterprise" },
    { id: tenantRace, name: "Voice Progress Race", slug: tenantRace, plan: "enterprise" },
    {
      id: tenantAchievements,
      name: "Voice Progress Achievements",
      slug: tenantAchievements,
      plan: "enterprise",
    },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: userA,
      tenantId: tenantA,
      email: `${userA}@test.invalid`,
      name: "Voice A",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userB,
      tenantId: tenantB,
      email: `${userB}@test.invalid`,
      name: "Voice B",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userRace,
      tenantId: tenantRace,
      email: `${userRace}@test.invalid`,
      name: "Voice Race",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userAchievements,
      tenantId: tenantAchievements,
      email: `${userAchievements}@test.invalid`,
      name: "Voice Achievements",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: platformUser,
      tenantId: tenantA,
      email: `${platformUser}@test.invalid`,
      name: "Platform",
      passwordHash: "x",
      role: "platform_admin",
    },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    {
      id: candidateA,
      tenantId: tenantA,
      userId: userA,
      firstName: "Voice",
      lastName: "A",
      email: `${candidateA}@test.invalid`,
      pool: "tenant",
    },
    {
      id: candidateB,
      tenantId: tenantB,
      userId: userB,
      firstName: "Voice",
      lastName: "B",
      email: `${candidateB}@test.invalid`,
      pool: "tenant",
    },
    {
      id: candidateOther,
      tenantId: tenantA,
      userId: null,
      firstName: "Other",
      lastName: "Candidate",
      email: `${candidateOther}@test.invalid`,
      pool: "tenant",
    },
    {
      id: candidateRace,
      tenantId: tenantRace,
      userId: userRace,
      firstName: "Race",
      lastName: "Candidate",
      email: `${candidateRace}@test.invalid`,
      pool: "tenant",
    },
    {
      id: candidateAchievements,
      tenantId: tenantAchievements,
      userId: userAchievements,
      firstName: "Achievement",
      lastName: "Candidate",
      email: `${candidateAchievements}@test.invalid`,
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
      id: id("career_race"),
      candidateId: candidateRace,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support",
      careerGoal5yr: "Support lead",
    },
    {
      id: id("career_achievements"),
      candidateId: candidateAchievements,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support",
      careerGoal5yr: "Support lead",
    },
  ]);
  await dbAdmin.insert(candidateLearningProfilesTable).values([
    {
      id: id("learning_a"),
      candidateId: candidateA,
      tenantId: tenantA,
      interests,
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
    },
    {
      id: id("learning_b"),
      candidateId: candidateB,
      tenantId: tenantB,
      interests,
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
    },
    {
      id: id("learning_race"),
      candidateId: candidateRace,
      tenantId: tenantRace,
      interests,
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
    },
    {
      id: id("learning_achievements"),
      candidateId: candidateAchievements,
      tenantId: tenantAchievements,
      interests,
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
    },
  ]);
  await dbAdmin.insert(candidateLearningEnrollmentsTable).values([
    {
      id: id("enrollment_a"),
      candidateId: candidateA,
      tenantId: tenantA,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "in_progress",
      enrolledAt: new Date(),
    },
    {
      id: id("enrollment_b"),
      candidateId: candidateB,
      tenantId: tenantB,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "completed",
      enrolledAt: new Date(),
      completedAt: new Date(),
    },
    {
      id: id("enrollment_race"),
      candidateId: candidateRace,
      tenantId: tenantRace,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "in_progress",
      enrolledAt: new Date(),
    },
    {
      id: id("enrollment_achievements"),
      candidateId: candidateAchievements,
      tenantId: tenantAchievements,
      courseId,
      courseVersion: 1,
      path: "voice",
      status: "completed",
      enrolledAt: new Date("2024-01-01"),
      completedAt: new Date("2024-01-02"),
    },
  ]);
  await dbAdmin.insert(candidateLearningVoiceCyclesTable).values({
    id: id("other_cycle"),
    candidateId: candidateOther,
    tenantId: tenantA,
    courseId,
    courseVersion: 1,
    comparisonFamilyVersion: "support-voice-progress-v1",
    rubricVersion: "support-communication-v1",
    evaluatorVersion: "deterministic-evaluator-v1",
    state: "baseline_draft",
  });
  const app = express();
  app.use(express.json());
  app.use(withTenantContext);
  app.use(learningGrowthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
  process.env.LEARNING_PILOT_ENABLED = "true";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = `${candidateA},${candidateB},${candidateRace},${candidateAchievements}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

test("candidate completes baseline, chronology gate unlocks Form B, and receives frozen private report", async () => {
  const started = await request("POST", "/portal/learning-growth/voice-progress", userA, tenantA, {
    courseId,
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.summary.form, "A");
  assert.equal("audio" in started.body, false);
  const formA = getVoiceProgressForm("A");
  const answer =
    "I acknowledge the concern, check the order details, confirm the next update, and provide a careful answer.";
  let detail = started.body;
  for (const prompt of formA.prompts) {
    const saved = await request(
      "PUT",
      `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${prompt.key}`,
      userA,
      tenantA,
      { revision: 0, response: answer, action: "submit" },
    );
    assert.equal(saved.status, 200);
    detail = saved.body;
  }
  assert.equal(detail.summary.state, "training_required");
  const baselineRewards = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(inArray(candidateLearningRewardLedgerTable.candidateId, [candidateA]));
  assert.equal(
    baselineRewards.filter((row) => row.eventType === "completed_voice_growth").length,
    0,
  );
  assert.equal(
    baselineRewards.reduce((sum, row) => sum + row.creditsDelta, 0),
    0,
  );
  const homeBeforeTraining = await request(
    "GET",
    "/portal/learning-growth/voice-progress",
    userA,
    tenantA,
  );
  assert.equal(homeBeforeTraining.status, 200);
  assert.equal(
    homeBeforeTraining.body.cycles.find((cycle: any) => cycle.id === detail.summary.id).action,
    "complete_training",
  );
  const blocked = await request(
    "POST",
    `/portal/learning-growth/voice-progress/${detail.summary.id}/start-progress`,
    userA,
    tenantA,
    {},
  );
  assert.equal(blocked.status, 403);
  const baselineCompletedAt = new Date();
  await dbAdmin
    .update(candidateLearningEnrollmentsTable)
    .set({ status: "completed", completedAt: new Date(baselineCompletedAt.getTime() + 1000) })
    .where(
      and(
        eq(candidateLearningEnrollmentsTable.candidateId, candidateA),
        eq(candidateLearningEnrollmentsTable.tenantId, tenantA),
      ),
    );
  const homeAfterTraining = await request(
    "GET",
    "/portal/learning-growth/voice-progress",
    userA,
    tenantA,
  );
  assert.equal(homeAfterTraining.status, 200);
  const readySummary = homeAfterTraining.body.cycles.find(
    (cycle: any) => cycle.id === detail.summary.id,
  );
  assert.equal(readySummary.state, "training_required");
  assert.equal(readySummary.action, "start_progress");
  assert.match(readySummary.reason, /completed after the baseline/i);
  const progress = await request(
    "POST",
    `/portal/learning-growth/voice-progress/${detail.summary.id}/start-progress`,
    userA,
    tenantA,
    {},
  );
  assert.equal(progress.status, 200);
  assert.equal(progress.body.summary.form, "B");
  const formB = getVoiceProgressForm("B");
  for (const prompt of formB.prompts) {
    const saved = await request(
      "PUT",
      `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${prompt.key}`,
      userA,
      tenantA,
      { revision: 0, response: answer, action: "submit" },
    );
    assert.equal(saved.status, 200);
    detail = saved.body;
  }
  assert.equal(detail.summary.state, "completed");
  const report = await request(
    "GET",
    `/portal/learning-growth/voice-progress/${detail.summary.id}/report`,
    userA,
    tenantA,
  );
  assert.equal(report.status, 200);
  assert.equal(report.body.comparison.comparable, true);
  const voiceRewards = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(inArray(candidateLearningRewardLedgerTable.candidateId, [candidateA]));
  assert.equal(voiceRewards.filter((row) => row.eventType === "completed_voice_growth").length, 1);
  assert.equal(
    voiceRewards.find((row) => row.eventType === "completed_voice_growth")?.creditsDelta,
    50,
  );
  const retryFinal = await request(
    "PUT",
    `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${formB.prompts.at(-1)?.key}`,
    userA,
    tenantA,
    { revision: 0, response: answer, action: "submit" },
  );
  assert.equal(retryFinal.status, 409);
  const rewardsAfterRetry = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(inArray(candidateLearningRewardLedgerTable.candidateId, [candidateA]));
  assert.equal(
    rewardsAfterRetry.filter((row) => row.eventType === "completed_voice_growth").length,
    1,
  );
  assert.equal("audio" in report.body, false);
  assert.equal(
    (
      await request(
        "GET",
        `/portal/learning-growth/voice-progress/${detail.summary.id}`,
        userB,
        tenantB,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/portal/learning-growth/voice-progress",
        platformUser,
        tenantA,
        undefined,
        "platform_admin",
      )
    ).status,
    403,
  );
  const frozen = JSON.stringify(report.body);
  const immutable = await request(
    "PUT",
    `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${formB.prompts[0].key}`,
    userA,
    tenantA,
    { revision: 1, response: answer, action: "submit" },
  );
  assert.equal(immutable.status, 409);
  assert.equal(immutable.body.code, "revision_conflict");
  assert.equal(
    JSON.stringify(
      (
        await request(
          "GET",
          `/portal/learning-growth/voice-progress/${detail.summary.id}/report`,
          userA,
          tenantA,
        )
      ).body,
    ),
    frozen,
  );
  const precompleted = await request(
    "POST",
    "/portal/learning-growth/voice-progress",
    userB,
    tenantB,
    { courseId },
  );
  assert.equal(precompleted.status, 200);
  let preDetail = precompleted.body;
  for (const prompt of formA.prompts) {
    const saved = await request(
      "PUT",
      `/portal/learning-growth/voice-progress/${preDetail.summary.id}/turns/${prompt.key}`,
      userB,
      tenantB,
      { revision: 0, response: answer, action: "submit" },
    );
    assert.equal(saved.status, 200);
    preDetail = saved.body;
  }
  assert.equal(preDetail.summary.state, "training_required");
  const reviewHome = await request("GET", "/portal/learning-growth/voice-progress", userB, tenantB);
  assert.equal(
    reviewHome.body.cycles.find((cycle: any) => cycle.id === preDetail.summary.id).action,
    "start_training_review",
  );
  const startedReview = await request(
    "POST",
    `/portal/learning-growth/voice-progress/${preDetail.summary.id}/training-review`,
    userB,
    tenantB,
    {},
  );
  assert.equal(startedReview.status, 200);
  for (const lesson of startedReview.body.lessons) {
    const reviewed = await request(
      "PUT",
      `/portal/learning-growth/voice-progress/${preDetail.summary.id}/training-review/lessons/${lesson.id}`,
      userB,
      tenantB,
      {},
    );
    assert.equal(reviewed.status, 200);
  }
  const retryReview = await request(
    "PUT",
    `/portal/learning-growth/voice-progress/${preDetail.summary.id}/training-review/lessons/${startedReview.body.lessons[0].id}`,
    userB,
    tenantB,
    {},
  );
  assert.equal(retryReview.status, 404);
  const reviewRows = await dbAdmin
    .select()
    .from(candidateLearningCourseReviewAttemptsTable)
    .where(eq(candidateLearningCourseReviewAttemptsTable.cycleId, preDetail.summary.id));
  assert.equal(reviewRows.length, 1);
  assert.equal(reviewRows[0].status, "completed");
  const reviewRewards = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(
      and(
        eq(candidateLearningRewardLedgerTable.candidateId, candidateB),
        eq(candidateLearningRewardLedgerTable.eventType, "completed_course_review"),
        eq(candidateLearningRewardLedgerTable.sourceId, reviewRows[0].id),
      ),
    );
  assert.equal(reviewRewards.length, 1);
  assert.equal(reviewRewards[0].creditsDelta, 10);
  const readyReviewHome = await request(
    "GET",
    "/portal/learning-growth/voice-progress",
    userB,
    tenantB,
  );
  assert.equal(
    readyReviewHome.body.cycles.find((cycle: any) => cycle.id === preDetail.summary.id).action,
    "start_progress",
  );
  assert.equal(
    (
      await request(
        "POST",
        `/portal/learning-growth/voice-progress/${preDetail.summary.id}/start-progress`,
        userB,
        tenantB,
        {},
      )
    ).status,
    200,
  );
});

test("voice progress RLS requires both tenant and candidate context", async () => {
  const client = await pool.connect();
  try {
    await client.query("SET ROLE lexy_app");
    await client.query(
      "SELECT set_config('app.allowed_tenant_ids', $1, false), set_config('app.current_tenant_id', $1, false), set_config('app.current_candidate_id', $2, false)",
      [tenantA, candidateA],
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_voice_cycles"))
          .rows[0].count,
      ),
      1,
    );
    await client.query("SELECT set_config('app.current_candidate_id', $1, false)", [
      candidateOther,
    ]);
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_voice_cycles"))
          .rows[0].count,
      ),
      1,
    );
    await client.query("SELECT set_config('app.current_candidate_id', '', false)");
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_voice_cycles"))
          .rows[0].count,
      ),
      0,
    );
  } finally {
    await client.query("DISCARD ALL").catch(() => {});
    await client.query("RESET ROLE").catch(() => {});
    client.release();
  }
});

test("voice progress rejects unauthenticated, wrong-role, malformed, and unknown writes privately", async () => {
  const unauthenticated = await unauthenticatedRequest(
    "GET",
    "/portal/learning-growth/voice-progress",
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(
    (
      await request(
        "GET",
        "/portal/learning-growth/voice-progress",
        platformUser,
        tenantA,
        undefined,
        "platform_admin",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("POST", "/portal/learning-growth/voice-progress", userA, tenantA, {
        courseId,
        extra: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("POST", "/portal/learning-growth/voice-progress", userA, tenantA, {
        courseId: "unknown-course",
      })
    ).status,
    404,
  );
  const response = await fetch(baseUrl + "/portal/learning-growth/voice-progress", {
    headers: {
      Authorization: `Bearer ${issueToken({ userId: userA, role: "candidate", tenantId: tenantA })}`,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
});

test("tracked review requires every catalog lesson and awards exactly once", async () => {
  const course = getLearningCourse(courseId)!;
  const lessons = course.lessons.filter(
    (lesson) => lesson.track === "shared" || lesson.track === "voice",
  );
  const cycleId = id("exact_set_cycle");
  const attemptId = id("exact_set_attempt");
  const now = new Date();
  await dbAdmin.insert(candidateLearningVoiceCyclesTable).values({
    id: cycleId,
    candidateId: candidateA,
    tenantId: tenantA,
    courseId,
    courseVersion: course.version,
    comparisonFamilyVersion: "support-voice-progress-v1",
    rubricVersion: "support-communication-v1",
    evaluatorVersion: "deterministic-evaluator-v1",
    state: "training",
    baselineCompletedAt: new Date(now.getTime() + 1000),
    createdAt: now,
    updatedAt: now,
  });
  await dbAdmin.insert(candidateLearningCourseReviewAttemptsTable).values({
    id: attemptId,
    candidateId: candidateA,
    tenantId: tenantA,
    cycleId,
    courseId,
    courseVersion: course.version,
    status: "in_progress",
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await dbAdmin.insert(candidateLearningCourseReviewLessonsTable).values(
    lessons.map((lesson, index) => ({
      id: id(`wrong_lesson_${index}`),
      candidateId: candidateA,
      tenantId: tenantA,
      attemptId,
      lessonId: index === lessons.length - 1 ? "not-a-catalog-lesson" : lesson.id,
      reviewedAt: now,
      createdAt: now,
    })),
  );
  const before = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateA));
  const missing = lessons.at(-1)!;
  const beforeMissing = await request(
    "GET",
    `/portal/learning-growth/voice-progress/${cycleId}/training-review`,
    userA,
    tenantA,
  );
  assert.equal(beforeMissing.status, 200);
  assert.equal(beforeMissing.body.status, "in_progress");
  assert.equal(beforeMissing.body.reviewedCount, lessons.length);
  const afterRejected = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateA));
  assert.equal(afterRejected.length, before.length);

  // The endpoint ignores the adversarial row and completes once all exact IDs exist.
  const added = await request(
    "PUT",
    `/portal/learning-growth/voice-progress/${cycleId}/training-review/lessons/${missing.id}`,
    userA,
    tenantA,
    {},
  );
  assert.equal(added.status, 200);
  assert.equal(added.body.status, "completed");
  const completed = await dbAdmin
    .select()
    .from(candidateLearningCourseReviewAttemptsTable)
    .where(eq(candidateLearningCourseReviewAttemptsTable.id, attemptId));
  assert.equal(completed[0].status, "completed");
  const rewardBeforeReplay = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(
      and(
        eq(candidateLearningRewardLedgerTable.candidateId, candidateA),
        eq(candidateLearningRewardLedgerTable.sourceId, attemptId),
      ),
    );
  assert.equal(rewardBeforeReplay.length, 1);
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/voice-progress/${cycleId}/training-review/lessons/${missing.id}`,
        userA,
        tenantA,
        {},
      )
    ).status,
    404,
  );
  const completedAfterReplay = await dbAdmin
    .select()
    .from(candidateLearningCourseReviewAttemptsTable)
    .where(eq(candidateLearningCourseReviewAttemptsTable.id, attemptId));
  assert.deepEqual(completedAfterReplay, completed);
  const rewardAfterReplay = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(
      and(
        eq(candidateLearningRewardLedgerTable.candidateId, candidateA),
        eq(candidateLearningRewardLedgerTable.sourceId, attemptId),
      ),
    );
  assert.deepEqual(rewardAfterReplay, rewardBeforeReplay);
  await dbAdmin
    .delete(candidateLearningVoiceCyclesTable)
    .where(eq(candidateLearningVoiceCyclesTable.id, cycleId));
});

test("achievements are private, balanced, deduplicated, deterministic, and capped", async () => {
  const fixtureNow = new Date("2098-01-01T00:00:00.000Z");
  const fixtureCycleId = id("achievement_cycle");
  const fixtureAttemptId = id("achievement_attempt");
  const fixtureAssessmentId = id("achievement_assessment");
  await dbAdmin.insert(candidateLearningVoiceCyclesTable).values({
    id: fixtureCycleId,
    candidateId: candidateAchievements,
    tenantId: tenantAchievements,
    courseId,
    courseVersion: 1,
    comparisonFamilyVersion: "support-voice-progress-v1",
    rubricVersion: "support-communication-v1",
    evaluatorVersion: "deterministic-evaluator-v1",
    state: "completed",
    baselineSnapshot: {},
    progressSnapshot: {},
    comparisonSnapshot: {},
    baselineCompletedAt: fixtureNow,
    completedAt: fixtureNow,
    createdAt: fixtureNow,
    updatedAt: fixtureNow,
  });
  await dbAdmin.insert(candidateLearningCourseReviewAttemptsTable).values({
    id: fixtureAttemptId,
    candidateId: candidateAchievements,
    tenantId: tenantAchievements,
    cycleId: fixtureCycleId,
    courseId,
    courseVersion: 1,
    status: "completed",
    startedAt: fixtureNow,
    completedAt: fixtureNow,
    createdAt: fixtureNow,
    updatedAt: fixtureNow,
  });
  await dbAdmin.insert(candidateLearningAssessmentsTable).values({
    id: fixtureAssessmentId,
    candidateId: candidateAchievements,
    tenantId: tenantAchievements,
    courseId,
    courseVersion: 1,
    path: "voice",
    taskSetVersion: 1,
    rubricVersion: "fixture",
    status: "completed",
    reportSnapshot: {},
    startedAt: fixtureNow,
    completedAt: fixtureNow,
    createdAt: fixtureNow,
    updatedAt: fixtureNow,
  });
  const otherOwnerBefore = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateRace));
  await dbAdmin.insert(candidateLearningRewardLedgerTable).values({
    id: id("achievement_other"),
    candidateId: candidateRace,
    tenantId: tenantRace,
    eventKey: id("achievement_other_event"),
    eventType: "completed_course",
    title: "Other owner",
    description: "Private test recognition",
    badgeKey: "other-owner-badge",
    creditsDelta: 7,
    sourceType: "test",
    sourceId: id("achievement_other_source"),
    earnedAt: fixtureNow,
    createdAt: fixtureNow,
  });
  const before = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateAchievements));
  const earnedAt = new Date("2099-01-01T00:00:00.000Z");
  await dbAdmin.insert(candidateLearningRewardLedgerTable).values(
    Array.from({ length: 25 }, (_, index) => ({
      id: id(`achievement_${String(index).padStart(2, "0")}`),
      candidateId: candidateAchievements,
      tenantId: tenantAchievements,
      eventKey: id(`achievement_event_${index}`),
      eventType: "completed_course" as const,
      title: `Achievement ${index}`,
      description: "Private test recognition",
      badgeKey: index < 2 ? "duplicate-badge" : `badge-${index}`,
      creditsDelta: index + 1,
      sourceType: "test",
      sourceId: id(`achievement_source_${index}`),
      earnedAt,
      createdAt: earnedAt,
    })),
  );
  const response = await request(
    "GET",
    "/portal/learning-growth/achievements",
    userAchievements,
    tenantAchievements,
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.body.creditsBalance,
    before.reduce((sum, row) => sum + row.creditsDelta, 0) + 325,
  );
  assert.equal(
    response.body.badges.filter((badge: any) => badge.key === "duplicate-badge").length,
    1,
  );
  assert.equal(
    new Set(response.body.badges.map((badge: any) => badge.key)).size,
    response.body.badges.length,
  );
  assert.equal(response.body.recentActivity.length, 20);
  assert.deepEqual(
    response.body.recentActivity.slice(0, 2).map((item: any) => item.id),
    [id("achievement_00"), id("achievement_01")],
  );
  assert.equal(
    response.body.milestones.find((item: any) => item.key === "first-course").current,
    1,
  );
  assert.equal(response.body.milestones.find((item: any) => item.key === "courses").current, 1);
  const otherOwner = await request(
    "GET",
    "/portal/learning-growth/achievements",
    userRace,
    tenantRace,
  );
  assert.equal(
    otherOwner.body.creditsBalance,
    otherOwnerBefore.reduce((sum, row) => sum + row.creditsDelta, 0) + 7,
  );
  assert.equal(
    otherOwner.body.recentActivity.some((item: any) => item.id === id("achievement_00")),
    false,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/portal/learning-growth/achievements",
        platformUser,
        tenantAchievements,
        undefined,
        "platform_admin",
      )
    ).status,
    403,
  );
  const privateResponse = await fetch(baseUrl + "/portal/learning-growth/achievements", {
    headers: {
      Authorization: `Bearer ${issueToken({ userId: userAchievements, role: "candidate", tenantId: tenantAchievements })}`,
    },
  });
  assert.equal(privateResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(privateResponse.headers.get("pragma"), "no-cache");
});

test("concurrent valid final progress writes produce one completion and one first-cycle reward", async () => {
  const answer =
    "I acknowledge the concern, check the order details, confirm the next update, and provide a careful answer.";
  const initialRewards = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateRace));
  assert.equal(
    initialRewards.filter((row) => row.eventType === "completed_voice_growth").length,
    0,
  );
  const started = await request(
    "POST",
    "/portal/learning-growth/voice-progress",
    userRace,
    tenantRace,
    { courseId },
  );
  assert.equal(started.status, 200);
  let detail = started.body;
  for (const prompt of getVoiceProgressForm("A").prompts) {
    detail = (
      await request(
        "PUT",
        `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${prompt.key}`,
        userRace,
        tenantRace,
        { revision: 0, response: answer, action: "submit" },
      )
    ).body;
  }
  await dbAdmin
    .update(candidateLearningEnrollmentsTable)
    .set({ status: "completed", completedAt: new Date(Date.now() + 100000) })
    .where(eq(candidateLearningEnrollmentsTable.candidateId, candidateRace));
  assert.equal(
    (
      await request(
        "POST",
        `/portal/learning-growth/voice-progress/${detail.summary.id}/start-progress`,
        userRace,
        tenantRace,
        {},
      )
    ).status,
    200,
  );
  const form = getVoiceProgressForm("B");
  for (const prompt of form.prompts.slice(0, -1)) {
    detail = (
      await request(
        "PUT",
        `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${prompt.key}`,
        userRace,
        tenantRace,
        { revision: 0, response: answer, action: "submit" },
      )
    ).body;
  }
  const finalPrompt = form.prompts.at(-1)!;
  const results = await Promise.all([
    request(
      "PUT",
      `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${finalPrompt.key}`,
      userRace,
      tenantRace,
      { revision: 0, response: answer, action: "submit" },
    ),
    request(
      "PUT",
      `/portal/learning-growth/voice-progress/${detail.summary.id}/turns/${finalPrompt.key}`,
      userRace,
      tenantRace,
      { revision: 0, response: answer, action: "submit" },
    ),
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  const report = await request(
    "GET",
    `/portal/learning-growth/voice-progress/${detail.summary.id}/report`,
    userRace,
    tenantRace,
  );
  assert.equal(report.status, 200);
  const rewards = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateRace));
  const voiceRewards = rewards.filter((row) => row.eventType === "completed_voice_growth");
  assert.equal(voiceRewards.length, 1);
  assert.equal(voiceRewards[0].eventKey, `${candidateRace}:voice-growth:first`);
  assert.equal(voiceRewards[0].creditsDelta, 50);
  assert.equal(voiceRewards[0].sourceType, "voice_progress");
  assert.equal(voiceRewards[0].sourceId, detail.summary.id);
});
