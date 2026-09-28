import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  candidateCareerProfilesTable,
  candidateLearningEnrollmentsTable,
  candidateLearningLessonProgressTable,
  candidateLearningProfilesTable,
  candidateLearningRewardLedgerTable,
  candidatesTable,
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { LEARNING_COURSES } from "../lib/learning-courses/catalog";
import { withTenantContext } from "../middlewares/withTenantContext";
import learningGrowthRouter from "./learning-growth";

const prefix = `learning_courses_${crypto.randomUUID().slice(0, 8)}_`;
const id = (suffix: string) => prefix + suffix;
const tenantA = id("tenant_a");
const tenantB = id("tenant_b");
const candidateA = id("candidate_a");
const candidateB = id("candidate_b");
const candidateC = id("candidate_c");
const userA = id("user_a");
const userB = id("user_b");
const userC = id("user_c");
const staff = id("staff");
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
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as any,
    cacheControl: response.headers.get("cache-control"),
  };
}

async function cleanup() {
  await dbAdmin
    .delete(candidateLearningRewardLedgerTable)
    .where(
      inArray(candidateLearningRewardLedgerTable.candidateId, [candidateA, candidateB, candidateC]),
    );
  await dbAdmin
    .delete(candidateLearningLessonProgressTable)
    .where(
      inArray(candidateLearningLessonProgressTable.candidateId, [
        candidateA,
        candidateB,
        candidateC,
      ]),
    )
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningEnrollmentsTable)
    .where(
      inArray(candidateLearningEnrollmentsTable.candidateId, [candidateA, candidateB, candidateC]),
    )
    .catch(() => {});
  await dbAdmin
    .delete(candidateLearningProfilesTable)
    .where(
      inArray(candidateLearningProfilesTable.candidateId, [candidateA, candidateB, candidateC]),
    )
    .catch(() => {});
  await dbAdmin
    .delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, [candidateA, candidateB, candidateC]))
    .catch(() => {});
  await dbAdmin
    .delete(candidatesTable)
    .where(inArray(candidatesTable.id, [candidateA, candidateB, candidateC]))
    .catch(() => {});
  await dbAdmin
    .delete(usersTable)
    .where(inArray(usersTable.id, [userA, userB, userC, staff]))
    .catch(() => {});
  await dbAdmin
    .delete(tenantsTable)
    .where(inArray(tenantsTable.id, [tenantA, tenantB]))
    .catch(() => {});
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: tenantA, name: "Course Tenant A", slug: tenantA, plan: "enterprise" },
    { id: tenantB, name: "Course Tenant B", slug: tenantB, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: userA,
      tenantId: tenantA,
      email: `${userA}@test.invalid`,
      name: "Candidate A",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userB,
      tenantId: tenantB,
      email: `${userB}@test.invalid`,
      name: "Candidate B",
      passwordHash: "x",
      role: "candidate",
    },
    {
      id: userC,
      tenantId: tenantA,
      email: `${userC}@test.invalid`,
      name: "Candidate C",
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
      firstName: "Candidate",
      lastName: "A",
      email: `${candidateA}@test.invalid`,
      pool: "tenant",
      talentMatchScore: 73,
      resumeScreenScore: 68,
    },
    {
      id: candidateB,
      tenantId: tenantB,
      userId: userB,
      firstName: "Candidate",
      lastName: "B",
      email: `${candidateB}@test.invalid`,
      pool: "tenant",
    },
    {
      id: candidateC,
      tenantId: tenantA,
      userId: userC,
      firstName: "Candidate",
      lastName: "C",
      email: `${candidateC}@test.invalid`,
      pool: "tenant",
    },
  ]);
  await dbAdmin.insert(candidateCareerProfilesTable).values([
    {
      id: id("career_a"),
      candidateId: candidateA,
      baselineInterviewCompleted: false,
      careerGoal3yr: "Support specialist",
      careerGoal5yr: "Support lead",
    },
    {
      id: id("career_b"),
      candidateId: candidateB,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support specialist",
      careerGoal5yr: "Support lead",
    },
    {
      id: id("career_c"),
      candidateId: candidateC,
      baselineInterviewCompleted: true,
      careerGoal3yr: "Support specialist",
      careerGoal5yr: "Support lead",
    },
  ]);
  await dbAdmin.insert(candidateLearningProfilesTable).values([
    {
      id: id("learning_a"),
      candidateId: candidateA,
      tenantId: tenantA,
      interests: {
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
      },
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support specialist",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
    },
    {
      id: id("learning_b"),
      candidateId: candidateB,
      tenantId: tenantB,
      interests: {
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
      },
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support specialist",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
    },
    {
      id: id("learning_c"),
      candidateId: candidateC,
      tenantId: tenantA,
      interests: {
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
      },
      immediateGoal: "Start in support",
      confirmedCareerGoal3yr: "Support specialist",
      confirmedCareerGoal5yr: "Support lead",
      goalsConfirmedAt: new Date(),
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
});

after(async () => {
  if (originalEnabled === undefined) delete process.env.LEARNING_PILOT_ENABLED;
  else process.env.LEARNING_PILOT_ENABLED = originalEnabled;
  if (originalAllowlist === undefined) delete process.env.LEARNING_PILOT_CANDIDATE_IDS;
  else process.env.LEARNING_PILOT_CANDIDATE_IDS = originalAllowlist;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await cleanup();
});

test("private candidate courses enforce rollout, prerequisites, paths, revisions, feedback and resume", async () => {
  const tokenA = token(userA, "candidate", tenantA);
  const tokenB = token(userB, "candidate", tenantB);
  const tokenC = token(userC, "candidate", tenantA);
  const course = LEARNING_COURSES[0];
  const sharedLessons = course.lessons.filter((lesson) => lesson.track === "shared");
  const chosenLessons = course.lessons.filter(
    (lesson) => lesson.track === "shared" || lesson.track === "voice",
  );
  const answerFor = (lesson: (typeof course.lessons)[number], correct: boolean) =>
    Object.fromEntries(
      lesson.exercises.map((exercise) => [
        exercise.id,
        exercise.type === "choice"
          ? correct
            ? exercise.correctOptionId!
            : exercise.options!.find((option) => option.id !== exercise.correctOptionId)!.id
          : "I would acknowledge the concern, clarify the request, and confirm a practical next step.",
      ]),
    );

  process.env.LEARNING_PILOT_ENABLED = "false";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = "*";
  const off = await request("GET", "/portal/learning-growth/courses", tokenA);
  assert.deepEqual(off.body, { available: false, unlocked: false, lockReason: null, courses: [] });
  assert.equal(off.cacheControl, "private, no-store");
  assert.equal(
    (
      await request("POST", `/portal/learning-growth/courses/${course.id}/enroll`, tokenA, {
        path: "voice",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("GET", "/portal/learning-growth/courses", token(staff, "tenant_admin", tenantA)))
      .status,
    403,
  );

  process.env.LEARNING_PILOT_ENABLED = "true";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = [candidateA, candidateB, candidateC].join(",");
  const locked = await request("GET", "/portal/learning-growth/courses", tokenA);
  assert.equal(locked.body.available, true);
  assert.equal(locked.body.unlocked, false);
  assert.deepEqual(locked.body.courses, []);
  assert.equal(
    (await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenA)).status,
    403,
  );

  await dbAdmin
    .update(candidateCareerProfilesTable)
    .set({ baselineInterviewCompleted: true })
    .where(eq(candidateCareerProfilesTable.candidateId, candidateA));
  const catalog = await request("GET", "/portal/learning-growth/courses", tokenA);
  assert.equal(catalog.body.courses.length, 2);
  assert.equal(catalog.body.courses[0].lessonCount, course.lessons.length);
  const outline = await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenA);
  assert.equal(outline.body.lessons.length, course.lessons.length);
  assert.ok(
    outline.body.lessons.every((lesson: any) =>
      lesson.exercises.every(
        (exercise: any) =>
          !("correctOptionId" in exercise) &&
          !("feedback" in exercise) &&
          !("modelAnswer" in exercise),
      ),
    ),
  );

  const enrolled = await request(
    "POST",
    `/portal/learning-growth/courses/${course.id}/enroll`,
    tokenA,
    { path: "voice" },
  );
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.body.lessons.length, chosenLessons.length);
  assert.equal(enrolled.body.course.enrollment.totalLessons, chosenLessons.length);
  const enrollmentId = enrolled.body.course.enrollment.id;
  const idempotent = await request(
    "POST",
    `/portal/learning-growth/courses/${course.id}/enroll`,
    tokenA,
    { path: "voice" },
  );
  assert.equal(idempotent.body.course.enrollment.id, enrollmentId);
  assert.equal(
    (
      await request("POST", `/portal/learning-growth/courses/${course.id}/enroll`, tokenA, {
        path: "chat_email",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("POST", `/portal/learning-growth/courses/${course.id}/enroll`, tokenA, {
        path: "voice",
        candidateId: candidateB,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/courses/${course.id}/lessons/${course.lessons.find((lesson) => lesson.track === "chat_email")!.id}`,
        tokenA,
        {
          revision: 0,
          answers: {},
          action: "save_draft",
        },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/courses/${course.id}/lessons/${sharedLessons[0].id}`,
        tokenA,
        {
          revision: 0,
          answers: { forged_exercise: "forged" },
          action: "save_draft",
        },
      )
    ).status,
    400,
  );

  const jumpedLesson = sharedLessons[4];
  const draft = await request(
    "PUT",
    `/portal/learning-growth/courses/${course.id}/lessons/${jumpedLesson.id}`,
    tokenA,
    {
      revision: 0,
      answers: { [jumpedLesson.exercises[1].id]: "A partial private draft" },
      action: "save_draft",
    },
  );
  assert.equal(draft.status, 200);
  assert.equal(
    draft.body.course.enrollment.resumeLessonId,
    jumpedLesson.id,
    "most recently saved unfinished lesson resumes",
  );
  assert.equal(
    draft.body.lessons.find((lesson: any) => lesson.id === jumpedLesson.id).progress.attempts,
    0,
  );

  const first = sharedLessons[0];
  const failed = await request(
    "PUT",
    `/portal/learning-growth/courses/${course.id}/lessons/${first.id}`,
    tokenA,
    {
      revision: 0,
      answers: answerFor(first, false),
      action: "submit",
    },
  );
  assert.equal(failed.status, 200);
  const failedProgress = failed.body.lessons.find((lesson: any) => lesson.id === first.id).progress;
  assert.equal(failedProgress.status, "draft");
  assert.equal(failedProgress.attempts, 1);
  assert.ok(failedProgress.feedback.some((item: any) => item.correct === false));
  const retry = await request(
    "PUT",
    `/portal/learning-growth/courses/${course.id}/lessons/${first.id}`,
    tokenA,
    {
      revision: failedProgress.revision,
      answers: answerFor(first, true),
      action: "submit",
    },
  );
  assert.equal(
    retry.body.lessons.find((lesson: any) => lesson.id === first.id).progress.status,
    "completed",
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/courses/${course.id}/lessons/${first.id}`,
        tokenA,
        {
          revision: 2,
          answers: answerFor(first, true),
          action: "submit",
        },
      )
    ).status,
    409,
    "completed lessons are immutable",
  );

  const concurrentLesson = sharedLessons[1];
  const concurrentBody = { revision: 0, answers: {}, action: "save_draft" };
  const concurrent = await Promise.all([
    request(
      "PUT",
      `/portal/learning-growth/courses/${course.id}/lessons/${concurrentLesson.id}`,
      tokenA,
      concurrentBody,
    ),
    request(
      "PUT",
      `/portal/learning-growth/courses/${course.id}/lessons/${concurrentLesson.id}`,
      tokenA,
      concurrentBody,
    ),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);

  const crossTenantRows = await request(
    "GET",
    `/portal/learning-growth/courses/${course.id}`,
    tokenB,
  );
  assert.equal(
    crossTenantRows.body.course.enrollment,
    null,
    "actual tenant middleware and RLS do not expose another candidate's enrolment",
  );
  const sameTenantOtherOwner = await request(
    "GET",
    `/portal/learning-growth/courses/${course.id}`,
    tokenC,
  );
  assert.equal(
    sameTenantOtherOwner.body.course.enrollment,
    null,
    "same-tenant candidates cannot read another candidate's enrolment",
  );

  let latest = await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenA);
  for (const lesson of chosenLessons) {
    const current = latest.body.lessons.find((item: any) => item.id === lesson.id);
    if (current.progress.status === "completed") continue;
    latest = await request(
      "PUT",
      `/portal/learning-growth/courses/${course.id}/lessons/${lesson.id}`,
      tokenA,
      {
        revision: current.progress.revision,
        answers: answerFor(lesson, true),
        action: "submit",
      },
    );
    assert.equal(latest.status, 200);
  }
  assert.equal(latest.body.course.enrollment.status, "completed");
  assert.equal(latest.body.course.enrollment.completedLessons, chosenLessons.length);
  assert.equal(latest.body.course.enrollment.resumeLessonId, null);
  const [scoreSnapshot] = await dbAdmin
    .select({
      talentMatchScore: candidatesTable.talentMatchScore,
      resumeScreenScore: candidatesTable.resumeScreenScore,
    })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateA));
  assert.deepEqual(
    scoreSnapshot,
    { talentMatchScore: 73, resumeScreenScore: 68 },
    "learning never changes candidate or hiring scores",
  );

  await dbAdmin
    .update(candidateLearningProfilesTable)
    .set({
      interests: {
        careerAreas: ["software_technology"],
        otherInterest: null,
        immediateRoles: ["Developer"],
        educationStage: "graduated",
        discipline: null,
        graduationYear: null,
        learningPriorities: ["communication"],
        preferredLanguage: null,
        accessibilityPreferences: null,
        startTiming: "now",
      },
    })
    .where(eq(candidateLearningProfilesTable.candidateId, candidateA));
  assert.equal(
    (await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenA)).status,
    200,
    "an existing enrolment remains private and accessible after interests change",
  );
  const reducedCatalog = await request("GET", "/portal/learning-growth/courses", tokenA);
  assert.deepEqual(
    reducedCatalog.body.courses.map((item: any) => item.id),
    [course.id],
    "without a current support interest the catalog contains only existing enrolments",
  );
  assert.equal(
    (await request("GET", `/portal/learning-growth/courses/${LEARNING_COURSES[1].id}`, tokenA))
      .status,
    404,
  );

  await dbAdmin
    .update(candidateCareerProfilesTable)
    .set({ careerGoal3yr: "Changed canonical goal" })
    .where(eq(candidateCareerProfilesTable.candidateId, candidateA));
  assert.equal(
    (await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenA)).status,
    403,
    "current canonical goal confirmation remains authoritative",
  );
});

test("course boundaries reject anonymous, non-candidate, nonmatching and malformed requests without mutation", async () => {
  const tokenB = token(userB, "candidate", tenantB);
  const course = LEARNING_COURSES[0];
  process.env.LEARNING_PILOT_ENABLED = "true";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = candidateB;

  assert.equal((await request("GET", "/portal/learning-growth/courses")).status, 401);
  assert.equal(
    (
      await request(
        "GET",
        "/portal/learning-growth/courses",
        token("unknown", "candidate", tenantA),
      )
    ).status,
    401,
  );
  assert.equal(
    (await request("GET", "/portal/learning-growth/courses", token(staff, "tenant_admin", tenantA)))
      .status,
    403,
  );
  process.env.LEARNING_PILOT_CANDIDATE_IDS = candidateA;
  const nonmatching = await request("GET", "/portal/learning-growth/courses", tokenB);
  assert.equal(nonmatching.status, 200);
  assert.deepEqual(nonmatching.body.courses, []);
  assert.equal(
    (await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenB)).status,
    404,
  );
  process.env.LEARNING_PILOT_CANDIDATE_IDS = candidateB;

  const before = await dbAdmin
    .select()
    .from(candidateLearningEnrollmentsTable)
    .where(eq(candidateLearningEnrollmentsTable.candidateId, candidateB));
  const invalidBodies = [{ path: "voice", extra: true }, { path: "invalid" }];
  for (const body of invalidBodies) {
    assert.equal(
      (await request("POST", `/portal/learning-growth/courses/${course.id}/enroll`, tokenB, body))
        .status,
      400,
    );
  }
  assert.equal(
    (
      await request("POST", `/portal/learning-growth/courses/not-a-course/enroll`, tokenB, {
        path: "voice",
      })
    ).status,
    404,
  );
  const duplicateEnrollments = await Promise.all([
    request("POST", `/portal/learning-growth/courses/${course.id}/enroll`, tokenB, {
      path: "voice",
    }),
    request("POST", `/portal/learning-growth/courses/${course.id}/enroll`, tokenB, {
      path: "voice",
    }),
  ]);
  assert.deepEqual(duplicateEnrollments.map((result) => result.status).sort(), [200, 200]);
  assert.equal(
    duplicateEnrollments[0].body.course.enrollment.id,
    duplicateEnrollments[1].body.course.enrollment.id,
    "concurrent duplicate enrollment is idempotent",
  );
  const after = await dbAdmin
    .select()
    .from(candidateLearningEnrollmentsTable)
    .where(eq(candidateLearningEnrollmentsTable.candidateId, candidateB));
  assert.equal(after.length, before.length + 1);
});

test("invalid submissions are atomic, stale course versions fail closed, and completion rewards are exact once", async () => {
  const tokenC = token(userC, "candidate", tenantA);
  const course = LEARNING_COURSES[0];
  process.env.LEARNING_PILOT_ENABLED = "true";
  process.env.LEARNING_PILOT_CANDIDATE_IDS = candidateC;

  const enrolled = await request(
    "POST",
    `/portal/learning-growth/courses/${course.id}/enroll`,
    tokenC,
    { path: "voice" },
  );
  assert.equal(enrolled.status, 200);
  const enrollmentId = enrolled.body.course.enrollment.id;
  const first = course.lessons.find((lesson) => lesson.track === "shared")!;
  const invalid = await request(
    "PUT",
    `/portal/learning-growth/courses/${course.id}/lessons/${first.id}`,
    tokenC,
    {
      revision: 0,
      answers: {},
      action: "submit",
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(candidateLearningLessonProgressTable)
        .where(eq(candidateLearningLessonProgressTable.enrollmentId, enrollmentId))
    ).length,
    0,
    "an incomplete submit cannot create draft progress",
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/portal/learning-growth/courses/${course.id}/lessons/${first.id}`,
        tokenC,
        {
          revision: 0,
          answers: {},
          action: "submit",
          ignored: "unknown",
        },
      )
    ).status,
    400,
  );

  await dbAdmin
    .update(candidateLearningEnrollmentsTable)
    .set({ courseVersion: course.version + 1 })
    .where(eq(candidateLearningEnrollmentsTable.id, enrollmentId));
  assert.equal(
    (await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenC)).status,
    409,
  );
  await dbAdmin
    .update(candidateLearningEnrollmentsTable)
    .set({ courseVersion: course.version })
    .where(eq(candidateLearningEnrollmentsTable.id, enrollmentId));

  const answerFor = (lesson: (typeof course.lessons)[number]) =>
    Object.fromEntries(
      lesson.exercises.map((exercise) => [
        exercise.id,
        exercise.type === "choice"
          ? exercise.correctOptionId!
          : "I would acknowledge the concern, clarify the request, and confirm a practical next step.",
      ]),
    );
  let latest = await request("GET", `/portal/learning-growth/courses/${course.id}`, tokenC);
  const chosenLessons = course.lessons.filter(
    (lesson) => lesson.track === "shared" || lesson.track === "voice",
  );
  for (const lesson of chosenLessons.slice(0, -1)) {
    const current = latest.body.lessons.find((item: any) => item.id === lesson.id);
    latest = await request(
      "PUT",
      `/portal/learning-growth/courses/${course.id}/lessons/${lesson.id}`,
      tokenC,
      {
        revision: current.progress.revision,
        answers: answerFor(lesson),
        action: "submit",
      },
    );
    assert.equal(latest.status, 200);
  }
  const finalLesson = chosenLessons[chosenLessons.length - 1];
  const finalState = latest.body.lessons.find((item: any) => item.id === finalLesson.id);
  const beforeFinish = await dbAdmin
    .select()
    .from(candidateLearningEnrollmentsTable)
    .where(eq(candidateLearningEnrollmentsTable.id, enrollmentId));
  assert.equal(beforeFinish[0].status, "in_progress");
  const finalWrites = await Promise.all([
    request(
      "PUT",
      `/portal/learning-growth/courses/${course.id}/lessons/${finalLesson.id}`,
      tokenC,
      {
        revision: finalState.progress.revision,
        answers: answerFor(finalLesson),
        action: "submit",
      },
    ),
    request(
      "PUT",
      `/portal/learning-growth/courses/${course.id}/lessons/${finalLesson.id}`,
      tokenC,
      {
        revision: finalState.progress.revision,
        answers: answerFor(finalLesson),
        action: "submit",
      },
    ),
  ]);
  assert.deepEqual(
    finalWrites.map((result) => result.status).sort(),
    [200, 409],
    "optimistic concurrency permits one final completion transition",
  );
  const [completedEnrollment] = await dbAdmin
    .select()
    .from(candidateLearningEnrollmentsTable)
    .where(eq(candidateLearningEnrollmentsTable.id, enrollmentId));
  assert.equal(completedEnrollment.status, "completed");
  assert.ok(completedEnrollment.completedAt);
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(candidateLearningEnrollmentsTable)
        .where(eq(candidateLearningEnrollmentsTable.id, enrollmentId))
    ).filter((row) => row.status === "completed" && row.completedAt !== null).length,
    1,
  );
  const rewards = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateC));
  assert.deepEqual(
    rewards.map((row) => row.eventKey).sort(),
    [`${candidateC}:course:${course.id}`, `${candidateC}:course:first`].sort(),
  );
  assert.deepEqual(
    rewards
      .map((row) => ({
        eventKey: row.eventKey,
        eventType: row.eventType,
        creditsDelta: row.creditsDelta,
      }))
      .sort((a, b) => a.eventKey.localeCompare(b.eventKey)),
    [
      {
        eventKey: `${candidateC}:course:${course.id}`,
        eventType: "completed_course",
        creditsDelta: 20,
      },
      {
        eventKey: `${candidateC}:course:first`,
        eventType: "first_completed_course",
        creditsDelta: 25,
      },
    ].sort((a, b) => a.eventKey.localeCompare(b.eventKey)),
  );
  const retry = await request(
    "PUT",
    `/portal/learning-growth/courses/${course.id}/lessons/${finalLesson.id}`,
    tokenC,
    {
      revision: 99,
      answers: answerFor(finalLesson),
      action: "submit",
    },
  );
  assert.equal(retry.status, 409);
  const rewardsAfterRetry = await dbAdmin
    .select()
    .from(candidateLearningRewardLedgerTable)
    .where(eq(candidateLearningRewardLedgerTable.candidateId, candidateC));
  assert.equal(rewardsAfterRetry.length, 2);
});

test("learning course RLS scopes enrollments, progress, and rewards to tenant and candidate", async () => {
  const client = await pool.connect();
  try {
    await client.query("SET ROLE lexy_app");
    await client.query(
      "SELECT set_config('app.allowed_tenant_ids', $1, false), set_config('app.current_tenant_id', $1, false), set_config('app.current_candidate_id', $2, false)",
      [tenantA, candidateC],
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_enrollments")).rows[0]
          .count,
      ),
      1,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_lesson_progress"))
          .rows[0].count,
      ),
      LEARNING_COURSES[0].lessons.filter(
        (lesson) => lesson.track === "shared" || lesson.track === "voice",
      ).length,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_reward_ledger"))
          .rows[0].count,
      ),
      2,
    );

    await client.query("SELECT set_config('app.current_candidate_id', $1, false)", [
      id("candidate_no_rows"),
    ]);
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_enrollments")).rows[0]
          .count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_lesson_progress"))
          .rows[0].count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_reward_ledger"))
          .rows[0].count,
      ),
      0,
    );

    await client.query("SELECT set_config('app.current_candidate_id', '', false)");
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_enrollments")).rows[0]
          .count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_lesson_progress"))
          .rows[0].count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_reward_ledger"))
          .rows[0].count,
      ),
      0,
    );

    await client.query(
      "SELECT set_config('app.allowed_tenant_ids', $1, false), set_config('app.current_tenant_id', $1, false), set_config('app.current_candidate_id', $2, false)",
      [tenantB, candidateC],
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_enrollments")).rows[0]
          .count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_lesson_progress"))
          .rows[0].count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await client.query("SELECT count(*) AS count FROM candidate_learning_reward_ledger"))
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
