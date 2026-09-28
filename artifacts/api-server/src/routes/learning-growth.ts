import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ConfirmLearningGrowthGoalsBody,
  ConfirmLearningGrowthGoalsResponse,
  EnrollLearningCourseBody,
  EnrollLearningCourseResponse,
  GetLearningGrowthResponse,
  GetLearningCourseResponse,
  ListLearningCoursesResponse,
  SaveLearningLessonBody,
  SaveLearningLessonResponse,
  SaveLearningGrowthInterestsBody,
  SaveLearningGrowthInterestsResponse,
} from "@workspace/api-zod";
import {
  candidateCareerProfilesTable,
  candidateLearningEnrollmentsTable,
  candidateLearningLessonProgressTable,
  candidateLearningAssessmentsTable,
  candidateLearningAssessmentTasksTable,
  candidateLearningVoiceCyclesTable,
  candidateLearningVoiceTurnsTable,
  candidateLearningCourseReviewAttemptsTable,
  candidateLearningCourseReviewLessonsTable,
  candidateLearningRewardLedgerTable,
  candidateLearningProfilesTable,
  candidatesTable,
  db,
  type CandidateLearningInterests,
  type CandidateLearningAssessmentTask,
} from "@workspace/db";
import { getLearningCourse, LEARNING_COURSES } from "../lib/learning-courses/catalog";
import type { CourseDefinition, LessonDefinition } from "../lib/learning-courses/types";
import {
  ASSESSMENT_RUBRIC_VERSION,
  ASSESSMENT_TASK_SET_VERSION,
  evaluateAssessment,
  getAssessmentDefinition,
} from "../lib/learning-assessments/catalog";
import type { AssessmentPath } from "../lib/learning-assessments/types";
import {
  ListLearningAssessmentsResponse,
  StartLearningAssessmentBody,
  StartLearningAssessmentResponse,
  GetLearningAssessmentResponse,
  SaveLearningAssessmentTaskBody,
  SaveLearningAssessmentTaskResponse,
  GetLearningAssessmentReportResponse,
  GetLearningVoiceProgressHomeResponse,
  StartLearningVoiceProgressCycleBody,
  StartLearningVoiceProgressCycleResponse,
  GetLearningVoiceProgressCycleResponse,
  SaveLearningVoiceProgressTurnBody,
  SaveLearningVoiceProgressTurnResponse,
  StartLearningVoiceProgressResponse,
  StartLearningVoiceProgressBody,
  CompleteLearningVoiceProgressTrainingReviewBody,
  CompleteLearningVoiceProgressTrainingReviewResponse,
  GetLearningVoiceProgressReportResponse,
  GetLearningVoiceTrainingReviewResponse,
  StartLearningVoiceTrainingReviewBody,
  StartLearningVoiceTrainingReviewResponse,
  ReviewLearningVoiceTrainingLessonBody,
  ReviewLearningVoiceTrainingLessonResponse,
  GetLearningAchievementsResponse,
} from "@workspace/api-zod";
import { resolveCandidateSession, type CandidateSession } from "../lib/portal-auth";
import { resolveUser } from "../middlewares/resolveUser";
import {
  getVoiceProgressForm,
  VOICE_PROGRESS_COMPARISON_FAMILY_VERSION,
  VOICE_PROGRESS_EVALUATOR_VERSION,
  VOICE_PROGRESS_RUBRIC_VERSION,
} from "../lib/learning-voice-progress/catalog";
import { compareVoiceProgress, evaluateVoiceProgress } from "../lib/learning-voice-progress/evaluator";
import type { VoiceProgressForm, VoiceProgressPhase } from "../lib/learning-voice-progress/types";
import { awardLearningReward, awardCourseCompletionRewards } from "../lib/learning-rewards";

const router: IRouter = Router();

const INTEREST_KEYS = new Set([
  "revision",
  "careerAreas",
  "otherInterest",
  "immediateRoles",
  "educationStage",
  "discipline",
  "graduationYear",
  "learningPriorities",
  "preferredLanguage",
  "accessibilityPreferences",
  "startTiming",
]);
const GOAL_KEYS = new Set(["revision", "immediateGoal", "careerGoal3yr", "careerGoal5yr"]);
const SUPPORT_ROLE_LABELS = new Set([
  "customer support",
  "customer service",
  "voice support",
  "chat support",
  "email support",
]);
const CAREER_AREA_LABELS: Record<string, string> = {
  software_technology: "software and technology",
  data_analytics: "data and analytics",
  finance_accounting: "finance and accounting",
  sales_marketing: "sales and marketing",
  customer_service: "customer service",
  operations: "operations",
  other: "another stated area",
  exploring: "career exploration",
};
const PRIORITY_LABELS: Record<string, string> = {
  first_job: "finding a first role",
  career_exploration: "career exploration",
  communication: "communication",
  interviews: "interview preparation",
  role_skills: "role-specific skills",
};

type InterestsInput = z.infer<typeof SaveLearningGrowthInterestsBody>;
type GoalsInput = z.infer<typeof ConfirmLearningGrowthGoalsBody>;

class RevisionConflict extends Error {}

function privateNoStore(_req: Request, res: Response, next: () => void) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

function unavailableResponse() {
  return {
    available: false,
    stage: "unavailable" as const,
    revision: 0,
    baseline: { completed: false, completedAt: null },
    interests: null,
    goals: {
      immediateGoal: "",
      careerGoal3yr: "",
      careerGoal5yr: "",
      confirmedAt: null,
    },
    plan: null,
  };
}

function pilotEnabled(candidateId: string): boolean {
  if (process.env.LEARNING_PILOT_ENABLED !== "true") return false;
  const allowed = new Set(
    (process.env.LEARNING_PILOT_CANDIDATE_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return allowed.has("*") || allowed.has(candidateId);
}

function supportsCustomerService(interests: CandidateLearningInterests | null): boolean {
  return !!interests && (
    interests.careerAreas.includes("customer_service")
    || interests.immediateRoles.some((role) => SUPPORT_ROLE_LABELS.has(normalizedSupportRole(role)))
  );
}

function hasOnlyKeys(value: unknown, allowed: Set<string>): boolean {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

async function ownerSession(req: Request, res: Response): Promise<CandidateSession | null> {
  if (!req.resolvedUser) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (req.resolvedUser.role !== "candidate") {
    res.status(403).json({ error: "Candidate access only" });
    return null;
  }
  const session = await resolveCandidateSession(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const [owner] = await db.select({ id: candidatesTable.id }).from(candidatesTable).where(and(
    eq(candidatesTable.id, session.candidateId),
    eq(candidatesTable.tenantId, session.tenantId),
    eq(candidatesTable.userId, session.userId),
  )).limit(1);
  if (!owner) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return session;
}

function normalizeOptional(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeInterests(input: InterestsInput): CandidateLearningInterests {
  const immediateRoles = [...new Set(input.immediateRoles.map((role) => role.trim()))];
  return {
    careerAreas: [...input.careerAreas],
    otherInterest: normalizeOptional(input.otherInterest),
    immediateRoles,
    educationStage: input.educationStage,
    discipline: normalizeOptional(input.discipline),
    graduationYear: input.graduationYear,
    learningPriorities: [...input.learningPriorities],
    preferredLanguage: normalizeOptional(input.preferredLanguage),
    accessibilityPreferences: normalizeOptional(input.accessibilityPreferences),
    startTiming: input.startTiming,
  };
}

function interestsAreValid(input: InterestsInput): boolean {
  if (!Number.isInteger(input.revision)) return false;
  if (input.graduationYear !== null && !Number.isInteger(input.graduationYear)) return false;
  if (new Set(input.careerAreas).size !== input.careerAreas.length) return false;
  if (new Set(input.learningPriorities).size !== input.learningPriorities.length) return false;
  if (input.immediateRoles.some((role) => !role.trim() || role.trim().length > 100)) return false;
  if (input.careerAreas.includes("other") && !input.otherInterest?.trim()) return false;
  return true;
}

function normalizedSupportRole(role: string): string {
  return role.trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
}

function buildPlan(interests: CandidateLearningInterests, goals: {
  immediateGoal: string;
  careerGoal3yr: string;
  careerGoal5yr: string;
}) {
  const nextSteps: Array<{
    id: string;
    title: string;
    description: string;
    kind: "practice" | "reflection" | "resource";
    href: string | null;
  }> = [{
    id: "review-immediate-goal",
    title: "Turn your immediate goal into next actions",
    description: `Review the concrete actions you can take toward your confirmed immediate goal: ${goals.immediateGoal}`,
    kind: "reflection",
    href: "/portal/career",
  }, {
    id: "review-longer-term-direction",
    title: "Review how your goals connect",
    description: `Compare your confirmed three-year goal (${goals.careerGoal3yr}) with your confirmed five-year direction (${goals.careerGoal5yr}) and note the experiences you want to build between them.`,
    kind: "reflection",
    href: "/portal/career",
  }];

  const prioritySteps = {
    first_job: {
      id: "prepare-for-first-role",
      title: "Prepare for first-role conversations",
      description: "Use interview preparation to practise explaining the roles you want and the experience you can evidence.",
      kind: "practice" as const,
      href: "/portal/prep",
    },
    career_exploration: {
      id: "compare-career-directions",
      title: "Compare your chosen career directions",
      description: `Reflect on how your selected career areas connect with your confirmed three-year goal: ${goals.careerGoal3yr}`,
      kind: "reflection" as const,
      href: "/portal/career",
    },
    communication: {
      id: "practise-clear-examples",
      title: "Practise clear career examples",
      description: "Draft concise examples that explain your experience and the kind of contribution you want to make.",
      kind: "practice" as const,
      href: null,
    },
    interviews: {
      id: "use-private-interview-prep",
      title: "Use private interview preparation",
      description: "Practise discussing your goals and experience. Preparation remains private and is not an employer assessment.",
      kind: "practice" as const,
      href: "/portal/prep",
    },
    role_skills: {
      id: "map-role-learning",
      title: "Map learning to your target roles",
      description: `Choose role-specific topics that support your confirmed five-year direction: ${goals.careerGoal5yr}`,
      kind: "resource" as const,
      href: null,
    },
  };
  for (const priority of interests.learningPriorities) {
    const step = prioritySteps[priority as keyof typeof prioritySteps];
    if (step && !nextSteps.some((existing) => existing.id === step.id)) nextSteps.push(step);
  }

  const supportsCustomerService = interests.careerAreas.includes("customer_service")
    || interests.immediateRoles.some((role) => SUPPORT_ROLE_LABELS.has(normalizedSupportRole(role)));
  const plannedCourses = supportsCustomerService ? [
    {
      id: "customer-support-communication-foundations",
      title: "Customer Support Communication Foundations",
      description: "A planned course preview for learners who explicitly selected customer service or a supported customer-support role. It is not yet launchable and does not enrol you.",
      status: "planned" as const,
    },
    {
      id: "customer-support-communication-in-practice",
      title: "Customer Support Communication in Practice",
      description: "A planned follow-on course preview focused on practising support communication. It is not yet launchable and does not enrol you.",
      status: "planned" as const,
    },
  ] : [];

  return {
    summary: `This private starting plan uses only your selected career areas (${interests.careerAreas.map((area) => CAREER_AREA_LABELS[area] ?? "stated interest").join(", ")}), learning priorities (${interests.learningPriorities.map((priority) => PRIORITY_LABELS[priority] ?? "stated priority").join(", ")}), and confirmed goals.`,
    startingPointNote: "This starting point is based on your stated interests and goals. It does not measure skills, aptitude, performance, employability, or hiring rank.",
    nextSteps,
    plannedCourses,
  };
}

async function loadState(database: any, session: CandidateSession) {
  const [profile] = await database.select({
    baselineInterviewCompleted: candidateCareerProfilesTable.baselineInterviewCompleted,
    careerGoal3yr: candidateCareerProfilesTable.careerGoal3yr,
    careerGoal5yr: candidateCareerProfilesTable.careerGoal5yr,
  }).from(candidateCareerProfilesTable)
    .innerJoin(candidatesTable, eq(candidatesTable.id, candidateCareerProfilesTable.candidateId))
    .where(and(
      eq(candidateCareerProfilesTable.candidateId, session.candidateId),
      eq(candidatesTable.id, session.candidateId),
      eq(candidatesTable.tenantId, session.tenantId),
      eq(candidatesTable.userId, session.userId),
    ))
    .limit(1);
  const [learning] = await database.select().from(candidateLearningProfilesTable).where(and(
    eq(candidateLearningProfilesTable.candidateId, session.candidateId),
    eq(candidateLearningProfilesTable.tenantId, session.tenantId),
  )).limit(1);
  return { profile, learning };
}

function responseFor(state: Awaited<ReturnType<typeof loadState>>) {
  const { profile, learning } = state;
  const baselineCompleted = profile?.baselineInterviewCompleted === true;
  const interests = learning?.interests ?? null;
  const profileGoal3yr = profile?.careerGoal3yr ?? "";
  const profileGoal5yr = profile?.careerGoal5yr ?? "";
  const confirmationCurrent = !!(
    baselineCompleted
    &&
    learning?.goalsConfirmedAt
    && learning.immediateGoal
    && learning.confirmedCareerGoal3yr === profileGoal3yr
    && learning.confirmedCareerGoal5yr === profileGoal5yr
  );
  const goals = {
    immediateGoal: learning?.immediateGoal ?? "",
    careerGoal3yr: profileGoal3yr,
    careerGoal5yr: profileGoal5yr,
    confirmedAt: confirmationCurrent ? learning!.goalsConfirmedAt : null,
  };
  const stage = !interests
    ? "interests"
    : !baselineCompleted
      ? "baseline"
      : !confirmationCurrent
        ? "goals"
        : "ready";
  return {
    available: true,
    stage,
    revision: learning?.revision ?? 0,
    // There is no reliable baseline completion timestamp in the canonical
    // profile, so completedAt must remain null rather than borrowing updatedAt.
    baseline: { completed: baselineCompleted, completedAt: null },
    interests,
    goals,
    plan: stage === "ready" ? buildPlan(interests!, {
      immediateGoal: goals.immediateGoal,
      careerGoal3yr: goals.careerGoal3yr,
      careerGoal5yr: goals.careerGoal5yr,
    }) : null,
  };
}

type LearningEnrollmentRow = typeof candidateLearningEnrollmentsTable.$inferSelect;
type LearningProgressRow = typeof candidateLearningLessonProgressTable.$inferSelect;

function courseLessons(course: CourseDefinition, path?: "voice" | "chat_email"): LessonDefinition[] {
  return path ? course.lessons.filter((lesson) => lesson.track === "shared" || lesson.track === path) : course.lessons;
}

function coursePrerequisite(state: Awaited<ReturnType<typeof loadState>>): string | null {
  if (state.profile?.baselineInterviewCompleted !== true) return "Complete your career baseline first";
  if (!state.learning?.interests) return "Save your learning interests first";
  if (!state.learning.goalsConfirmedAt
    || !state.learning.immediateGoal
    || state.learning.confirmedCareerGoal3yr !== (state.profile.careerGoal3yr ?? "")
    || state.learning.confirmedCareerGoal5yr !== (state.profile.careerGoal5yr ?? "")) {
    return "Review and confirm your current goals first";
  }
  return null;
}

async function loadEnrollments(database: any, session: CandidateSession, courseId?: string) {
  return database.select().from(candidateLearningEnrollmentsTable).where(and(
    eq(candidateLearningEnrollmentsTable.candidateId, session.candidateId),
    eq(candidateLearningEnrollmentsTable.tenantId, session.tenantId),
    ...(courseId ? [eq(candidateLearningEnrollmentsTable.courseId, courseId)] : []),
  ));
}

async function loadProgress(database: any, session: CandidateSession, enrollmentId: string) {
  return database.select().from(candidateLearningLessonProgressTable).where(and(
    eq(candidateLearningLessonProgressTable.enrollmentId, enrollmentId),
    eq(candidateLearningLessonProgressTable.candidateId, session.candidateId),
    eq(candidateLearningLessonProgressTable.tenantId, session.tenantId),
  ));
}

function enrollmentDto(course: CourseDefinition, enrollment: LearningEnrollmentRow, progress: LearningProgressRow[]) {
  const lessons = courseLessons(course, enrollment.path);
  const completed = new Set(progress.filter((row) => row.status === "completed").map((row) => row.lessonId));
  const activeDraft = progress
    .filter((row) => row.status === "draft" && !completed.has(row.lessonId))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  return {
    id: enrollment.id,
    path: enrollment.path,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt,
    completedAt: enrollment.completedAt ?? null,
    completedLessons: completed.size,
    totalLessons: lessons.length,
    resumeLessonId: activeDraft?.lessonId ?? lessons.find((lesson) => !completed.has(lesson.id))?.id ?? null,
  };
}

function courseSummary(course: CourseDefinition, enrollment?: LearningEnrollmentRow, progress: LearningProgressRow[] = []) {
  const lessons = courseLessons(course, enrollment?.path);
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    version: course.version,
    estimatedMinutes: lessons.reduce((sum, lesson) => sum + lesson.estimatedMinutes, 0),
    lessonCount: lessons.length,
    enrollment: enrollment ? enrollmentDto(course, enrollment, progress) : null,
  };
}

function publicLesson(lesson: LessonDefinition, progress?: LearningProgressRow) {
  return {
    id: lesson.id,
    title: lesson.title,
    track: lesson.track,
    estimatedMinutes: lesson.estimatedMinutes,
    objectives: lesson.objectives,
    sections: lesson.sections,
    example: lesson.example,
    exercises: lesson.exercises.map((exercise) => ({
      id: exercise.id,
      type: exercise.type,
      prompt: exercise.prompt,
      options: exercise.options ?? [],
      checklist: exercise.checklist,
    })),
    progress: progress ? {
      revision: progress.revision,
      status: progress.status,
      answers: progress.answers,
      attempts: progress.attempts,
      completedAt: progress.completedAt ?? null,
      feedback: progress.feedback,
    } : {
      revision: 0,
      status: "not_started" as const,
      answers: {},
      attempts: 0,
      completedAt: null,
      feedback: [],
    },
  };
}

async function detailFor(database: any, session: CandidateSession, course: CourseDefinition, enrollment?: LearningEnrollmentRow) {
  if (enrollment && enrollment.courseVersion !== course.version) {
    throw new RevisionConflict("Course content version changed; this enrolment cannot be opened");
  }
  const progress: LearningProgressRow[] = enrollment ? await loadProgress(database, session, enrollment.id) : [];
  const progressByLesson = new Map(progress.map((row) => [row.lessonId, row]));
  return {
    course: courseSummary(course, enrollment, progress),
    lessons: courseLessons(course, enrollment?.path).map((lesson) => publicLesson(lesson, progressByLesson.get(lesson.id))),
  };
}

async function courseAccess(req: Request, res: Response, courseId?: string) {
  const session = await ownerSession(req, res);
  if (!session) return null;
  if (!pilotEnabled(session.candidateId)) {
    if (!courseId) return { session, available: false as const };
    res.status(404).json({ error: "Learning pilot unavailable" });
    return null;
  }
  const state = await loadState(db, session);
  const lockReason = coursePrerequisite(state);
  if (lockReason) {
    if (!courseId) return { session, available: true as const, unlocked: false as const, lockReason };
    res.status(403).json({ error: lockReason });
    return null;
  }
  const enrollments: LearningEnrollmentRow[] = await loadEnrollments(db, session, courseId);
  const currentSupportInterest = supportsCustomerService(state.learning?.interests ?? null);
  const eligible = currentSupportInterest || enrollments.length > 0;
  if (!eligible) {
    if (!courseId) return { session, available: true as const, unlocked: true as const, hidden: true as const, enrollments };
    res.status(404).json({ error: "Course not available for your current interests" });
    return null;
  }
  return {
    session,
    available: true as const,
    unlocked: true as const,
    hidden: false as const,
    currentSupportInterest,
    enrollments,
  };
}

router.use("/portal/learning-growth", privateNoStore);

router.get("/portal/learning-growth", resolveUser, async (req, res): Promise<void> => {
  const session = await ownerSession(req, res);
  if (!session) return;
  // The off switch is deliberately checked before either private profile table.
  if (!pilotEnabled(session.candidateId)) {
    res.json(GetLearningGrowthResponse.parse(unavailableResponse()));
    return;
  }
  res.json(GetLearningGrowthResponse.parse(responseFor(await loadState(db, session))));
});

router.put("/portal/learning-growth/interests", resolveUser, async (req, res): Promise<void> => {
  const session = await ownerSession(req, res);
  if (!session) return;
  if (!pilotEnabled(session.candidateId)) {
    res.status(404).json({ error: "Learning pilot unavailable" });
    return;
  }
  if (!hasOnlyKeys(req.body, INTEREST_KEYS)) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const parsed = SaveLearningGrowthInterestsBody.safeParse(req.body);
  if (!parsed.success || !interestsAreValid(parsed.data)) {
    res.status(400).json({ error: "Invalid learning interests" });
    return;
  }
  const interests = normalizeInterests(parsed.data);
  const now = new Date();
  let saved = false;
  if (parsed.data.revision === 0) {
    const inserted = await db.insert(candidateLearningProfilesTable).values({
      id: crypto.randomUUID(),
      candidateId: session.candidateId,
      tenantId: session.tenantId,
      interests,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning({ id: candidateLearningProfilesTable.id });
    saved = inserted.length === 1;
  } else {
    const updated = await db.update(candidateLearningProfilesTable).set({
      interests,
      revision: parsed.data.revision + 1,
      updatedAt: now,
    }).where(and(
      eq(candidateLearningProfilesTable.candidateId, session.candidateId),
      eq(candidateLearningProfilesTable.tenantId, session.tenantId),
      eq(candidateLearningProfilesTable.revision, parsed.data.revision),
    )).returning({ id: candidateLearningProfilesTable.id });
    saved = updated.length === 1;
  }
  if (!saved) {
    res.status(409).json({ error: "Learning profile changed; reload and try again" });
    return;
  }
  res.json(SaveLearningGrowthInterestsResponse.parse(responseFor(await loadState(db, session))));
});

router.put("/portal/learning-growth/goals", resolveUser, async (req, res): Promise<void> => {
  const session = await ownerSession(req, res);
  if (!session) return;
  if (!pilotEnabled(session.candidateId)) {
    res.status(404).json({ error: "Learning pilot unavailable" });
    return;
  }
  if (!hasOnlyKeys(req.body, GOAL_KEYS)) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const parsed = ConfirmLearningGrowthGoalsBody.safeParse(req.body);
  const goals = parsed.success ? {
    revision: parsed.data.revision,
    immediateGoal: parsed.data.immediateGoal.trim(),
    careerGoal3yr: parsed.data.careerGoal3yr.trim(),
    careerGoal5yr: parsed.data.careerGoal5yr.trim(),
  } : null;
  if (!goals
    || !Number.isInteger(goals.revision)
    || !goals.immediateGoal
    || !goals.careerGoal3yr
    || !goals.careerGoal5yr) {
    res.status(400).json({ error: "Goals must contain non-empty text" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      const state = await loadState(tx, session);
      if (!state.learning?.interests || state.profile?.baselineInterviewCompleted !== true) {
        throw new RevisionConflict("Complete saved interests and the career baseline before confirming goals");
      }
      if (state.learning.revision !== goals.revision) {
        throw new RevisionConflict("Learning profile changed; reload and try again");
      }
      const candidateOwnership = exists(
        tx.select({ id: candidatesTable.id }).from(candidatesTable).where(and(
          eq(candidatesTable.id, session.candidateId),
          eq(candidatesTable.tenantId, session.tenantId),
          eq(candidatesTable.userId, session.userId),
        )),
      );
      const profileUpdated = await tx.update(candidateCareerProfilesTable).set({
        careerGoal3yr: goals.careerGoal3yr,
        careerGoal5yr: goals.careerGoal5yr,
        updatedAt: new Date(),
      }).where(and(
        eq(candidateCareerProfilesTable.candidateId, session.candidateId),
        candidateOwnership,
      )).returning({ id: candidateCareerProfilesTable.id });
      if (profileUpdated.length !== 1) {
        throw new RevisionConflict("Career baseline is unavailable");
      }
      const confirmedAt = new Date();
      const learningUpdated = await tx.update(candidateLearningProfilesTable).set({
        immediateGoal: goals.immediateGoal,
        confirmedCareerGoal3yr: goals.careerGoal3yr,
        confirmedCareerGoal5yr: goals.careerGoal5yr,
        goalsConfirmedAt: confirmedAt,
        revision: goals.revision + 1,
        updatedAt: confirmedAt,
      }).where(and(
        eq(candidateLearningProfilesTable.candidateId, session.candidateId),
        eq(candidateLearningProfilesTable.tenantId, session.tenantId),
        eq(candidateLearningProfilesTable.revision, goals.revision),
      )).returning({ id: candidateLearningProfilesTable.id });
      if (learningUpdated.length !== 1) {
        throw new RevisionConflict("Learning profile changed; reload and try again");
      }
    });
  } catch (error) {
    if (error instanceof RevisionConflict) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  res.json(ConfirmLearningGrowthGoalsResponse.parse(responseFor(await loadState(db, session))));
});

router.get("/portal/learning-growth/courses", resolveUser, async (req, res): Promise<void> => {
  const access = await courseAccess(req, res);
  if (!access) return;
  if (!access.available) {
    res.json(ListLearningCoursesResponse.parse({
      available: false, unlocked: false, lockReason: null, courses: [],
    }));
    return;
  }
  if (!access.unlocked) {
    res.json(ListLearningCoursesResponse.parse({
      available: true, unlocked: false, lockReason: access.lockReason, courses: [],
    }));
    return;
  }
  if (access.hidden) {
    res.json(ListLearningCoursesResponse.parse({
      available: true, unlocked: true, lockReason: null, courses: [],
    }));
    return;
  }
  const progressRows: LearningProgressRow[] = access.enrollments.length
    ? await db.select().from(candidateLearningLessonProgressTable).where(and(
      eq(candidateLearningLessonProgressTable.candidateId, access.session.candidateId),
      eq(candidateLearningLessonProgressTable.tenantId, access.session.tenantId),
      inArray(candidateLearningLessonProgressTable.enrollmentId, access.enrollments.map((row) => row.id)),
    ))
    : [];
  if (access.enrollments.some((enrollment) =>
    getLearningCourse(enrollment.courseId)?.version !== enrollment.courseVersion)) {
    res.status(409).json({ error: "Course content version changed; an enrolment cannot be opened" });
    return;
  }
  res.json(ListLearningCoursesResponse.parse({
    available: true,
    unlocked: true,
    lockReason: null,
    courses: LEARNING_COURSES
      .filter((course) => access.currentSupportInterest
        || access.enrollments.some((row) => row.courseId === course.id))
      .map((course) => {
      const enrollment = access.enrollments.find((row) => row.courseId === course.id);
      return courseSummary(course, enrollment, enrollment
        ? progressRows.filter((row) => row.enrollmentId === enrollment.id)
        : []);
    }),
  }));
});

router.get("/portal/learning-growth/courses/:courseId", resolveUser, async (req, res): Promise<void> => {
  const courseId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const course = getLearningCourse(courseId);
  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }
  const access = await courseAccess(req, res, course.id);
  if (!access || !("enrollments" in access)) return;
  try {
    res.json(GetLearningCourseResponse.parse(
      await detailFor(db, access.session, course, access.enrollments?.[0]),
    ));
  } catch (error) {
    if (error instanceof RevisionConflict) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/portal/learning-growth/courses/:courseId/enroll", resolveUser, async (req, res): Promise<void> => {
  const parsed = EnrollLearningCourseBody.safeParse(req.body);
  if (!parsed.success || !hasOnlyKeys(req.body, new Set(["path"]))) {
    res.status(400).json({ error: "Invalid enrolment" });
    return;
  }
  const courseId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const course = getLearningCourse(courseId);
  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }
  const access = await courseAccess(req, res, course.id);
  if (!access || !("enrollments" in access)) return;
  let enrollment = access.enrollments?.[0];
  if (enrollment) {
    if (enrollment.courseVersion !== course.version) {
      res.status(409).json({ error: "Course content version changed; this enrolment cannot be modified" });
      return;
    }
    if (enrollment.path !== parsed.data.path) {
      res.status(409).json({ error: "Learning path is fixed after enrolment" });
      return;
    }
  } else {
    const now = new Date();
    const inserted = await db.insert(candidateLearningEnrollmentsTable).values({
      id: crypto.randomUUID(),
      candidateId: access.session.candidateId,
      tenantId: access.session.tenantId,
      courseId: course.id,
      courseVersion: course.version,
      path: parsed.data.path,
      status: "in_progress",
      enrolledAt: now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (inserted.length === 0) {
      [enrollment] = await loadEnrollments(db, access.session, course.id);
      if (!enrollment || enrollment.path !== parsed.data.path) {
        res.status(409).json({ error: "Learning path is fixed after enrolment" });
        return;
      }
    } else {
      [enrollment] = inserted;
    }
  }
  res.json(EnrollLearningCourseResponse.parse(await detailFor(db, access.session, course, enrollment)));
});

router.put("/portal/learning-growth/courses/:courseId/lessons/:lessonId", resolveUser, async (req, res): Promise<void> => {
  const parsed = SaveLearningLessonBody.safeParse(req.body);
  if (!parsed.success || !hasOnlyKeys(req.body, new Set(["revision", "answers", "action"]))) {
    res.status(400).json({ error: "Invalid lesson submission" });
    return;
  }
  const courseId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const lessonId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const course = getLearningCourse(courseId);
  if (!course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }
  const access = await courseAccess(req, res, course.id);
  if (!access || !("enrollments" in access)) return;
  const enrollment = access.enrollments?.[0];
  if (!enrollment) {
    res.status(404).json({ error: "Enrol in this course before saving lessons" });
    return;
  }
  if (enrollment.courseVersion !== course.version) {
    res.status(409).json({ error: "Course content version changed; this enrolment cannot be modified" });
    return;
  }
  const lesson = courseLessons(course, enrollment.path).find((item) => item.id === lessonId);
  if (!lesson) {
    res.status(404).json({ error: "Lesson is not part of your learning path" });
    return;
  }
  const exerciseIds = new Set(lesson.exercises.map((exercise) => exercise.id));
  const answerEntries = Object.entries(parsed.data.answers);
  if (!Number.isInteger(parsed.data.revision)
    || answerEntries.length > 20
    || answerEntries.some(([exerciseId, answer]) => !exerciseIds.has(exerciseId) || answer.length > 4000)) {
    res.status(400).json({ error: "Answers contain an unknown exercise or too much text" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM candidate_learning_enrollments
        WHERE id = ${enrollment.id} AND candidate_id = ${access.session.candidateId}
          AND tenant_id = ${access.session.tenantId} FOR UPDATE`);
      const [existing] = await tx.select().from(candidateLearningLessonProgressTable).where(and(
        eq(candidateLearningLessonProgressTable.enrollmentId, enrollment.id),
        eq(candidateLearningLessonProgressTable.candidateId, access.session.candidateId),
        eq(candidateLearningLessonProgressTable.tenantId, access.session.tenantId),
        eq(candidateLearningLessonProgressTable.lessonId, lesson.id),
      )).limit(1).for("update");
      if (existing?.status === "completed") throw new RevisionConflict("Completed lessons are read-only");
      if ((existing?.revision ?? 0) !== parsed.data.revision) {
        throw new RevisionConflict("Lesson changed; reload and try again");
      }

      let feedback: Array<{ exerciseId: string; message: string; correct: boolean | null; modelAnswer: string | null }> = [];
      let completed = false;
      if (parsed.data.action === "submit") {
        if (lesson.exercises.some((exercise) =>
          !Object.prototype.hasOwnProperty.call(parsed.data.answers, exercise.id))) {
          throw new TypeError("Answer every exercise before submitting");
        }
        feedback = lesson.exercises.map((exercise) => {
          const answer = parsed.data.answers[exercise.id]?.trim() ?? "";
          if (exercise.type === "choice") {
            const validOption = exercise.options?.some((option) => option.id === answer) ?? false;
            if (!validOption) throw new TypeError(`Invalid choice for exercise ${exercise.id}`);
            const correct = answer === exercise.correctOptionId;
            return {
              exerciseId: exercise.id,
              message: correct ? exercise.feedback : `Not quite. ${exercise.feedback}`,
              correct,
              modelAnswer: null,
            };
          }
          if (answer.replace(/\s/g, "").length < 20) {
            throw new TypeError(`Reflection for exercise ${exercise.id} must contain at least 20 non-space characters`);
          }
          return {
            exerciseId: exercise.id,
            message: `${exercise.feedback} Review the checklist and sample response as coaching, not a proficiency score.`,
            correct: null,
            modelAnswer: exercise.modelAnswer ?? null,
          };
        });
        completed = feedback.every((item) => item.correct !== false);
      } else {
        feedback = existing?.feedback ?? [];
      }
      const now = new Date();
      const values = {
        enrollmentId: enrollment.id,
        candidateId: access.session.candidateId,
        tenantId: access.session.tenantId,
        lessonId: lesson.id,
        courseVersion: course.version,
        revision: parsed.data.revision + 1,
        status: completed ? "completed" as const : "draft" as const,
        answers: parsed.data.answers,
        feedback,
        attempts: (existing?.attempts ?? 0) + (parsed.data.action === "submit" ? 1 : 0),
        completedAt: completed ? now : null,
        updatedAt: now,
      };
      if (existing) {
        const updated = await tx.update(candidateLearningLessonProgressTable).set(values).where(and(
          eq(candidateLearningLessonProgressTable.id, existing.id),
          eq(candidateLearningLessonProgressTable.revision, parsed.data.revision),
        )).returning({ id: candidateLearningLessonProgressTable.id });
        if (!updated.length) throw new RevisionConflict("Lesson changed; reload and try again");
      } else {
        const inserted = await tx.insert(candidateLearningLessonProgressTable).values({
          id: crypto.randomUUID(),
          ...values,
          createdAt: now,
        }).onConflictDoNothing().returning({ id: candidateLearningLessonProgressTable.id });
        if (!inserted.length) throw new RevisionConflict("Lesson changed; reload and try again");
      }
      if (completed) {
        const completedRows = await tx.select({ lessonId: candidateLearningLessonProgressTable.lessonId })
          .from(candidateLearningLessonProgressTable).where(and(
            eq(candidateLearningLessonProgressTable.enrollmentId, enrollment.id),
            eq(candidateLearningLessonProgressTable.status, "completed"),
          ));
        if (completedRows.length === courseLessons(course, enrollment.path).length) {
          await tx.update(candidateLearningEnrollmentsTable).set({
            status: "completed",
            completedAt: now,
            updatedAt: now,
          }).where(and(
            eq(candidateLearningEnrollmentsTable.id, enrollment.id),
            eq(candidateLearningEnrollmentsTable.candidateId, access.session.candidateId),
            eq(candidateLearningEnrollmentsTable.tenantId, access.session.tenantId),
          ));
          await awardCourseCompletionRewards(tx, {
            candidateId: access.session.candidateId, tenantId: access.session.tenantId,
            courseId: enrollment.courseId, sourceId: enrollment.id,
          });
        }
      }
    });
  } catch (error) {
    if (error instanceof RevisionConflict) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof TypeError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  const [freshEnrollment] = await loadEnrollments(db, access.session, course.id);
  res.json(SaveLearningLessonResponse.parse(await detailFor(db, access.session, course, freshEnrollment)));
});

const ASSESSMENT_COMPARISON_REASON =
  "The initial career baseline did not capture a comparable structured task, so this report shows current evidence only.";

function assessmentSummary(row: typeof candidateLearningAssessmentsTable.$inferSelect, definition: NonNullable<ReturnType<typeof getAssessmentDefinition>>, tasks: Array<typeof candidateLearningAssessmentTasksTable.$inferSelect>) {
  const submitted = new Set(tasks.filter((task) => task.status === "submitted").map((task) => task.taskKey));
  const resume = definition.tasks.find((task) => !submitted.has(task.key));
  return {
    id: row.id, courseId: row.courseId, title: definition.title, path: row.path,
    status: row.status, taskSetVersion: row.taskSetVersion, rubricVersion: row.rubricVersion,
    startedAt: row.startedAt, completedAt: row.completedAt ?? null,
    completedTasks: submitted.size, totalTasks: definition.tasks.length,
    resumeTaskKey: row.status === "completed" ? null : (resume?.key ?? null),
  };
}

function assessmentDetail(row: typeof candidateLearningAssessmentsTable.$inferSelect, definition: NonNullable<ReturnType<typeof getAssessmentDefinition>>, taskRows: Array<typeof candidateLearningAssessmentTasksTable.$inferSelect>) {
  const byKey = new Map(taskRows.map((task) => [task.taskKey, task]));
  return {
    summary: assessmentSummary(row, definition, taskRows),
    tasks: definition.tasks.map((task) => {
      const progress = byKey.get(task.key);
      return {
        key: task.key, title: task.title, instructions: task.instructions, scenario: task.instructions,
        responseMode: task.responseMode, minimumNonSpaceCharacters: task.minimumNonSpaceCharacters,
        coveredDimensions: task.coveredDimensions,
        progress: {
          revision: progress?.revision ?? 0,
          status: progress?.status ?? "not_started",
          response: progress?.response ?? "",
          updatedAt: progress?.updatedAt ?? null,
        },
      };
    }),
  };
}

async function assessmentRows(session: CandidateSession) {
  const rows = await db.select().from(candidateLearningAssessmentsTable).where(and(
    eq(candidateLearningAssessmentsTable.candidateId, session.candidateId),
    eq(candidateLearningAssessmentsTable.tenantId, session.tenantId),
  ));
  const tasks = rows.length ? await db.select().from(candidateLearningAssessmentTasksTable).where(and(
    eq(candidateLearningAssessmentTasksTable.candidateId, session.candidateId),
    eq(candidateLearningAssessmentTasksTable.tenantId, session.tenantId),
  )) : [];
  return { rows, tasks };
}

async function assessmentAccess(req: Request, res: Response, courseId?: string) {
  const session = await ownerSession(req, res);
  if (!session) return null;
  if (!pilotEnabled(session.candidateId)) {
    if (!courseId) return { session, available: false as const };
    res.status(404).json({ error: "Learning pilot unavailable" });
    return null;
  }
  const state = await loadState(db, session);
  const lockReason = coursePrerequisite(state);
  if (lockReason) {
    if (!courseId) return { session, available: true as const, unlockedCourses: [] as string[], lockReason, locked: true as const };
    res.status(403).json({ error: lockReason });
    return null;
  }
  const enrollments: LearningEnrollmentRow[] = await loadEnrollments(db, session, courseId);
  const completed = enrollments.filter((row) => row.status === "completed");
  if (courseId && completed.length === 0) {
    res.status(403).json({ error: "Complete the course before starting its developmental reassessment" });
    return null;
  }
  return { session, available: true as const, unlockedCourses: completed.map((row) => row.courseId), enrollments: completed };
}

router.get("/portal/learning-growth/assessments", resolveUser, async (req, res): Promise<void> => {
  const access = await assessmentAccess(req, res);
  if (!access) return;
  if (!access.available) {
    res.json(ListLearningAssessmentsResponse.parse({ available: false, unlockedCourses: [], assessments: [] }));
    return;
  }
  if ("locked" in access && access.locked) {
    res.json(ListLearningAssessmentsResponse.parse({ available: true, unlockedCourses: [], assessments: [] }));
    return;
  }
  const { rows, tasks } = await assessmentRows(access.session);
  res.json(ListLearningAssessmentsResponse.parse({
    available: true,
    unlockedCourses: access.unlockedCourses,
    assessments: rows.map((row) => {
      const definition = getAssessmentDefinition(row.courseId, row.path as AssessmentPath);
      return definition ? assessmentSummary(row, definition, tasks.filter((task: CandidateLearningAssessmentTask) => task.assessmentId === row.id)) : null;
    }).filter(Boolean),
  }));
});

router.post("/portal/learning-growth/assessments", resolveUser, async (req, res): Promise<void> => {
  const parsed = StartLearningAssessmentBody.safeParse(req.body);
  if (!parsed.success || !hasOnlyKeys(req.body, new Set(["courseId"]))) {
    res.status(400).json({ error: "Invalid assessment request" }); return;
  }
  const access = await assessmentAccess(req, res, parsed.data.courseId);
  if (!access || !("enrollments" in access)) return;
  const enrollment = access.enrollments![0];
  const course = getLearningCourse(parsed.data.courseId);
  const definition = course ? getAssessmentDefinition(course.id, enrollment.path as AssessmentPath) : undefined;
  if (!course || !definition || course.version !== enrollment.courseVersion) {
    res.status(409).json({ error: "Course content version changed; this assessment cannot be opened" }); return;
  }
  const existing = await db.select().from(candidateLearningAssessmentsTable).where(and(
    eq(candidateLearningAssessmentsTable.candidateId, access.session.candidateId),
    eq(candidateLearningAssessmentsTable.tenantId, access.session.tenantId),
    eq(candidateLearningAssessmentsTable.courseId, course.id),
    eq(candidateLearningAssessmentsTable.status, "draft"),
  ));
  let row = existing[0];
  if (!row) {
    const now = new Date();
    const inserted = await db.insert(candidateLearningAssessmentsTable).values({
      id: crypto.randomUUID(), candidateId: access.session.candidateId, tenantId: access.session.tenantId,
      courseId: course.id, courseVersion: course.version, path: enrollment.path,
      taskSetVersion: ASSESSMENT_TASK_SET_VERSION, rubricVersion: ASSESSMENT_RUBRIC_VERSION,
      status: "draft", startedAt: now, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning();
    row = inserted[0] ?? (await db.select().from(candidateLearningAssessmentsTable).where(and(
      eq(candidateLearningAssessmentsTable.candidateId, access.session.candidateId),
      eq(candidateLearningAssessmentsTable.tenantId, access.session.tenantId),
      eq(candidateLearningAssessmentsTable.courseId, course.id),
      eq(candidateLearningAssessmentsTable.status, "draft"),
    )))[0];
  }
  if (!row) { res.status(409).json({ error: "Assessment changed; reload and try again" }); return; }
  const taskRows = await db.select().from(candidateLearningAssessmentTasksTable).where(and(
    eq(candidateLearningAssessmentTasksTable.assessmentId, row.id),
    eq(candidateLearningAssessmentTasksTable.tenantId, access.session.tenantId),
  ));
  res.json(StartLearningAssessmentResponse.parse(assessmentDetail(row, definition, taskRows)));
});

router.get("/portal/learning-growth/assessments/:assessmentId", resolveUser, async (req, res): Promise<void> => {
  const access = await assessmentAccess(req, res);
  if (!access) return;
  const id = String(req.params.assessmentId);
  const [row] = await db.select().from(candidateLearningAssessmentsTable).where(and(
    eq(candidateLearningAssessmentsTable.id, id), eq(candidateLearningAssessmentsTable.candidateId, access.session.candidateId),
    eq(candidateLearningAssessmentsTable.tenantId, access.session.tenantId),
  ));
  const definition = row && getAssessmentDefinition(row.courseId, row.path as AssessmentPath);
  if (!row || !definition || !("unlockedCourses" in access) || !access.unlockedCourses.includes(row.courseId)) {
    res.status(404).json({ error: "Assessment not found" }); return;
  }
  const tasks = await db.select().from(candidateLearningAssessmentTasksTable).where(eq(candidateLearningAssessmentTasksTable.assessmentId, row.id));
  res.json(GetLearningAssessmentResponse.parse(assessmentDetail(row, definition, tasks)));
});

router.put("/portal/learning-growth/assessments/:assessmentId/tasks/:taskKey", resolveUser, async (req, res): Promise<void> => {
  const parsed = SaveLearningAssessmentTaskBody.safeParse(req.body);
  if (!parsed.success || !hasOnlyKeys(req.body, new Set(["revision", "response", "action"]))) {
    res.status(400).json({ error: "Invalid assessment task request" }); return;
  }
  const access = await assessmentAccess(req, res);
  if (!access) return;
  const assessmentId = String(req.params.assessmentId);
  const taskKey = String(req.params.taskKey);
  const [row] = await db.select().from(candidateLearningAssessmentsTable).where(and(
    eq(candidateLearningAssessmentsTable.id, assessmentId), eq(candidateLearningAssessmentsTable.candidateId, access.session.candidateId),
    eq(candidateLearningAssessmentsTable.tenantId, access.session.tenantId),
  ));
  const definition = row && getAssessmentDefinition(row.courseId, row.path as AssessmentPath);
  const taskDefinition = definition?.tasks.find((task) => task.key === taskKey);
  if (!row || !definition || !taskDefinition || !("unlockedCourses" in access) || !access.unlockedCourses.includes(row.courseId)) {
    res.status(404).json({ error: "Assessment task not found" }); return;
  }
  if (row.status === "completed") { res.status(409).json({ error: "Completed assessments are immutable" }); return; }
  const response = parsed.data.response;
  if (parsed.data.action === "submit" && response.replace(/\s/gu, "").length < taskDefinition.minimumNonSpaceCharacters) {
    res.status(400).json({ error: `Response must contain at least ${taskDefinition.minimumNonSpaceCharacters} non-space characters` }); return;
  }
  try {
    const committed = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(candidateLearningAssessmentsTable).where(and(
        eq(candidateLearningAssessmentsTable.id, assessmentId),
        eq(candidateLearningAssessmentsTable.candidateId, access.session.candidateId),
        eq(candidateLearningAssessmentsTable.tenantId, access.session.tenantId),
      )).for("update");
      if (!locked || locked.status === "completed") throw new RevisionConflict("Completed assessments are immutable");
      const now = new Date();
      const [existing] = await tx.select().from(candidateLearningAssessmentTasksTable).where(and(
        eq(candidateLearningAssessmentTasksTable.assessmentId, locked.id),
        eq(candidateLearningAssessmentTasksTable.candidateId, access.session.candidateId),
        eq(candidateLearningAssessmentTasksTable.tenantId, access.session.tenantId),
        eq(candidateLearningAssessmentTasksTable.taskKey, taskKey),
      ));
      if (!existing && parsed.data.revision !== 0) throw new RevisionConflict("Assessment task changed; reload and try again");
      if (existing?.status === "submitted") throw new RevisionConflict("Submitted tasks are immutable");
      if (existing && existing.revision !== parsed.data.revision) throw new RevisionConflict("Assessment task changed; reload and try again");
      if (!existing) {
        const inserted = await tx.insert(candidateLearningAssessmentTasksTable).values({
          id: crypto.randomUUID(), assessmentId: locked.id, candidateId: access.session.candidateId,
          tenantId: access.session.tenantId, taskKey, revision: 1,
          status: parsed.data.action === "submit" ? "submitted" : "draft", response, updatedAt: now, createdAt: now,
        }).onConflictDoNothing().returning();
        if (!inserted.length) throw new RevisionConflict("Assessment task changed; reload and try again");
      } else {
        const updated = await tx.update(candidateLearningAssessmentTasksTable).set({
          revision: existing.revision + 1, status: parsed.data.action === "submit" ? "submitted" : "draft",
          response, updatedAt: now,
        }).where(and(
          eq(candidateLearningAssessmentTasksTable.id, existing.id),
          eq(candidateLearningAssessmentTasksTable.assessmentId, locked.id),
          eq(candidateLearningAssessmentTasksTable.candidateId, access.session.candidateId),
          eq(candidateLearningAssessmentTasksTable.tenantId, access.session.tenantId),
          eq(candidateLearningAssessmentTasksTable.revision, parsed.data.revision),
        )).returning();
        if (!updated.length) throw new RevisionConflict("Assessment task changed; reload and try again");
      }
      const allTasks = await tx.select().from(candidateLearningAssessmentTasksTable).where(and(
        eq(candidateLearningAssessmentTasksTable.assessmentId, locked.id),
        eq(candidateLearningAssessmentTasksTable.candidateId, access.session.candidateId),
        eq(candidateLearningAssessmentTasksTable.tenantId, access.session.tenantId),
      ));
      let finalRow = locked;
      if (allTasks.length === definition.tasks.length && definition.tasks.every((task) =>
        allTasks.some((item) => item.taskKey === task.key && item.status === "submitted"))) {
        const evaluated = evaluateAssessment(definition, Object.fromEntries(allTasks.map((item) => [item.taskKey, item.response])));
        const course = getLearningCourse(locked.courseId);
        const lessonMap = new Map(course ? courseLessons(course, locked.path as AssessmentPath).map((lesson) => [lesson.id, lesson.title]) : []);
        const snapshot = {
          summary: { title: definition.title, courseId: locked.courseId, path: locked.path, totalTasks: definition.tasks.length },
          versions: { taskSetVersion: locked.taskSetVersion, rubricVersion: locked.rubricVersion },
          comparison: { available: false, reason: ASSESSMENT_COMPARISON_REASON },
          overallSummary: evaluated.overallSummary,
          dimensions: evaluated.dimensions.map((item) => ({
            dimension: item.dimension, label: item.label,
            level: item.level, levelLabel: item.level === "not_observed" ? "Not observed" : item.level[0].toUpperCase() + item.level.slice(1),
            evidence: item.evidence, observed: item.observed, possible: item.possible,
          })),
          recommendations: [...new Set(evaluated.recommendations.filter((lessonId) => lessonMap.has(lessonId)))].map((lessonId) => ({
            lessonId, courseId: locked.courseId, lessonTitle: lessonMap.get(lessonId) ?? lessonId,
            reason: "Review this lesson for additional practice based on the current task evidence.",
          })),
        };
        const [updatedParent] = await tx.update(candidateLearningAssessmentsTable).set({
          status: "completed", completedAt: now, reportSnapshot: snapshot, updatedAt: now,
        }).where(and(
          eq(candidateLearningAssessmentsTable.id, locked.id),
          eq(candidateLearningAssessmentsTable.candidateId, access.session.candidateId),
          eq(candidateLearningAssessmentsTable.tenantId, access.session.tenantId),
          eq(candidateLearningAssessmentsTable.status, "draft"),
        )).returning();
        if (!updatedParent) throw new RevisionConflict("Assessment changed; reload and try again");
        await awardLearningReward(tx, {
          candidateId: access.session.candidateId, tenantId: access.session.tenantId,
          eventKey: `${access.session.candidateId}:assessment:first`, eventType: "first_completed_assessment",
          title: "Structured reassessment completed", description: "You completed a private structured learning reassessment.",
          badgeKey: "first-assessment", creditsDelta: 25, sourceType: "assessment", sourceId: locked.id,
        });
        finalRow = updatedParent;
      }
      const freshTasks = await tx.select().from(candidateLearningAssessmentTasksTable).where(and(
        eq(candidateLearningAssessmentTasksTable.assessmentId, finalRow.id),
        eq(candidateLearningAssessmentTasksTable.candidateId, access.session.candidateId),
        eq(candidateLearningAssessmentTasksTable.tenantId, access.session.tenantId),
      ));
      return { finalRow, freshTasks };
    });
    res.json(SaveLearningAssessmentTaskResponse.parse(assessmentDetail(committed.finalRow, definition, committed.freshTasks)));
  } catch (error) {
    if (error instanceof RevisionConflict) {
      res.status(409).json({ error: error.message }); return;
    }
    throw error;
  }
});

router.get("/portal/learning-growth/assessments/:assessmentId/report", resolveUser, async (req, res): Promise<void> => {
  const access = await assessmentAccess(req, res);
  if (!access) return;
  const [row] = await db.select().from(candidateLearningAssessmentsTable).where(and(
    eq(candidateLearningAssessmentsTable.id, String(req.params.assessmentId)),
    eq(candidateLearningAssessmentsTable.candidateId, access.session.candidateId),
    eq(candidateLearningAssessmentsTable.tenantId, access.session.tenantId),
  ));
  if (!row) { res.status(404).json({ error: "Assessment not found" }); return; }
  if (!("unlockedCourses" in access) || !access.unlockedCourses.includes(row.courseId)) {
    res.status(404).json({ error: "Assessment not found" }); return;
  }
  if (row.status !== "completed" || !row.reportSnapshot) { res.status(409).json({ error: "Assessment is not completed" }); return; }
  const frozenSnapshot = z.object({
    summary: z.object({ title: z.string(), courseId: z.string(), path: z.enum(["voice", "chat_email"]), totalTasks: z.number().int().nonnegative() }),
    versions: z.object({ taskSetVersion: z.number().int(), rubricVersion: z.string() }),
    comparison: z.object({ available: z.boolean(), reason: z.string().nullable() }),
    overallSummary: z.string(),
    dimensions: z.array(z.object({
      dimension: z.string(), label: z.string(), level: z.enum(["emerging", "developing", "consistent", "not_observed"]),
      levelLabel: z.string(), evidence: z.array(z.string()), observed: z.number().int(), possible: z.number().int(),
    })),
    recommendations: z.array(z.object({ lessonId: z.string(), courseId: z.string(), lessonTitle: z.string(), reason: z.string() })),
  }).safeParse(row.reportSnapshot);
  if (!frozenSnapshot.success) { res.status(500).json({ error: "Stored assessment report is invalid" }); return; }
  const snapshot = frozenSnapshot.data;
  const report = {
    summary: {
      id: row.id, courseId: snapshot.summary.courseId, title: snapshot.summary.title, path: snapshot.summary.path,
      status: row.status, taskSetVersion: snapshot.versions.taskSetVersion, rubricVersion: snapshot.versions.rubricVersion,
      startedAt: row.startedAt, completedAt: row.completedAt ?? null,
      completedTasks: snapshot.summary.totalTasks, totalTasks: snapshot.summary.totalTasks, resumeTaskKey: null,
    },
    versions: snapshot.versions,
    comparison: snapshot.comparison,
    overallSummary: snapshot.overallSummary,
    dimensions: snapshot.dimensions,
    recommendations: snapshot.recommendations,
  };
  res.json(GetLearningAssessmentReportResponse.parse(report));
});

type VoiceCycleRow = typeof candidateLearningVoiceCyclesTable.$inferSelect;
type VoiceTurnRow = typeof candidateLearningVoiceTurnsTable.$inferSelect;
type ReviewAttemptRow = typeof candidateLearningCourseReviewAttemptsTable.$inferSelect;
type ReviewLessonRow = typeof candidateLearningCourseReviewLessonsTable.$inferSelect;

function voiceCycleState(state: VoiceCycleRow["state"]): "baseline_draft" | "training_required" | "progress_draft" | "completed" {
  return state === "training" ? "training_required" : state;
}

function voiceTrainingReady(cycle: VoiceCycleRow, enrollments: LearningEnrollmentRow[]): boolean {
  const baselineCompletedAt = cycle.baselineCompletedAt;
  return cycle.state === "training"
    && baselineCompletedAt !== null
    && enrollments.some((enrollment) =>
      enrollment.courseId === cycle.courseId
      && enrollment.path === "voice"
      && enrollment.status === "completed"
      && enrollment.courseVersion === cycle.courseVersion
      && enrollment.completedAt !== null
      && enrollment.completedAt > baselineCompletedAt);
}

function voiceCycleSummary(cycle: VoiceCycleRow, turns: VoiceTurnRow[], enrollments: LearningEnrollmentRow[] = [], review?: { attempt: ReviewAttemptRow; reviewedCount: number; total: number }) {
  const phase: VoiceProgressPhase = cycle.state === "progress_draft" || cycle.state === "completed" ? "progress" : "baseline";
  const form: VoiceProgressForm = phase === "progress" ? "B" : "A";
  const prompts = getVoiceProgressForm(form).prompts;
  const submitted = turns.filter((turn) => turn.phase === phase && turn.status === "submitted").length;
  const trainingReady = voiceTrainingReady(cycle, enrollments);
  const matchingCompletedEnrollment = enrollments.find((enrollment) =>
    enrollment.courseId === cycle.courseId && enrollment.path === "voice"
    && enrollment.status === "completed" && enrollment.courseVersion === cycle.courseVersion
    && enrollment.completedAt !== null);
  const matchingCompletedAt = matchingCompletedEnrollment?.completedAt ?? null;
  const needsTrainingReview = cycle.state === "training"
    && !trainingReady
    && cycle.trainingCompletedAt === null
    && matchingCompletedAt !== null
    && cycle.baselineCompletedAt !== null
    && matchingCompletedAt <= cycle.baselineCompletedAt;
  const reason = cycle.state === "baseline_draft"
    ? "Complete the structured baseline before training so a later interview can be compared honestly."
    : cycle.state === "training"
      ? trainingReady || (cycle.trainingCompletedAt !== null && cycle.baselineCompletedAt !== null && cycle.trainingCompletedAt > cycle.baselineCompletedAt)
        ? "Training was completed after the baseline. The progress interview is ready."
        : review
          ? "Continue reviewing the completed voice course to unlock the progress interview."
        : needsTrainingReview
          ? "This voice course was completed before the baseline. Review it, then confirm your training review to unlock the progress interview."
          : "Your baseline is complete. Complete the matching voice course after that baseline to unlock the progress interview."
      : cycle.state === "progress_draft"
        ? "Complete the fresh equivalent voice interview to view your private observed-change report."
        : "Your private observed-change report is ready.";
  const action = cycle.state === "baseline_draft" ? "complete_baseline"
    : cycle.state === "training" ? (trainingReady || (cycle.trainingCompletedAt !== null && cycle.baselineCompletedAt !== null && cycle.trainingCompletedAt > cycle.baselineCompletedAt) ? "start_progress" : review ? "continue_training_review" : needsTrainingReview ? "start_training_review" : "complete_training")
      : cycle.state === "progress_draft" ? "complete_progress" : "view_report";
  return {
    id: cycle.id, courseId: cycle.courseId, state: voiceCycleState(cycle.state), form,
    comparisonFamilyVersion: cycle.comparisonFamilyVersion, rubricVersion: cycle.rubricVersion,
    evaluatorVersion: cycle.evaluatorVersion, baselineCompletedAt: cycle.baselineCompletedAt ?? null,
    progressStartedAt: cycle.progressStartedAt ?? null, completedAt: cycle.completedAt ?? null,
    completedTurns: submitted, totalTurns: prompts.length, reason, action,
    reviewedCount: review?.reviewedCount ?? 0, totalReviewLessons: review?.total ?? 0, reviewAttemptId: review?.attempt.id ?? null,
  };
}

function voiceCycleDetail(cycle: VoiceCycleRow, turns: VoiceTurnRow[]) {
  const phase: VoiceProgressPhase = cycle.state === "progress_draft" || cycle.state === "completed" ? "progress" : "baseline";
  const form: VoiceProgressForm = phase === "progress" ? "B" : "A";
  const prompts = getVoiceProgressForm(form).prompts;
  const byKey = new Map(turns.filter((turn) => turn.phase === phase).map((turn) => [turn.taskKey, turn]));
  return {
    summary: voiceCycleSummary(cycle, turns),
    turns: cycle.state === "training" ? [] : prompts.map((prompt) => {
      const turn = byKey.get(prompt.key);
      return {
        key: prompt.key, prompt: prompt.prompt, phase, form,
        minimumNonSpaceCharacters: prompt.minimumNonSpaceCharacters,
        progress: {
          revision: turn?.revision ?? 0,
          status: turn?.status ?? "not_started",
          response: turn?.response ?? "",
          updatedAt: turn?.updatedAt ?? null,
        },
      };
    }),
    privacy: {
      audioStorage: "Lexy stores editable transcript text only; no audio is received or stored.",
      speechDisclosure: "Optional browser speech services may process dictation under your browser settings. Typed responses are always available.",
    },
  };
}

async function voiceCycleAccess(req: Request, res: Response, cycleId?: string) {
  const session = await ownerSession(req, res);
  if (!session) return null;
  if (!pilotEnabled(session.candidateId)) {
    if (!cycleId) return { session, available: false as const };
    res.status(404).json({ error: "Voice progress interview not found" });
    return null;
  }
  const state = await loadState(db, session);
  const lockReason = coursePrerequisite(state);
  if (lockReason) {
    if (!cycleId) return { session, available: true as const, locked: true as const, lockReason };
    res.status(404).json({ error: "Voice progress interview not found" });
    return null;
  }
  if (!cycleId) return { session, available: true as const };
  const [cycle] = await db.select().from(candidateLearningVoiceCyclesTable).where(and(
    eq(candidateLearningVoiceCyclesTable.id, cycleId),
    eq(candidateLearningVoiceCyclesTable.candidateId, session.candidateId),
    eq(candidateLearningVoiceCyclesTable.tenantId, session.tenantId),
  ));
  if (!cycle) {
    res.status(404).json({ error: "Voice progress interview not found" });
    return null;
  }
  const turns = await db.select().from(candidateLearningVoiceTurnsTable).where(and(
    eq(candidateLearningVoiceTurnsTable.cycleId, cycleId),
    eq(candidateLearningVoiceTurnsTable.candidateId, session.candidateId),
    eq(candidateLearningVoiceTurnsTable.tenantId, session.tenantId),
  ));
  return { session, available: true as const, cycle, turns };
}

router.get("/portal/learning-growth/voice-progress", resolveUser, async (req, res): Promise<void> => {
  const access = await voiceCycleAccess(req, res);
  if (!access) return;
  if (!access.available || ("locked" in access && access.locked)) {
    res.json(GetLearningVoiceProgressHomeResponse.parse({ available: access.available, eligibleCourses: [], cycles: [] }));
    return;
  }
  const cycles = await db.select().from(candidateLearningVoiceCyclesTable).where(and(
    eq(candidateLearningVoiceCyclesTable.candidateId, access.session.candidateId),
    eq(candidateLearningVoiceCyclesTable.tenantId, access.session.tenantId),
  ));
  const turns = cycles.length ? await db.select().from(candidateLearningVoiceTurnsTable).where(and(
    eq(candidateLearningVoiceTurnsTable.candidateId, access.session.candidateId),
    eq(candidateLearningVoiceTurnsTable.tenantId, access.session.tenantId),
  )) : [];
  const enrollments: LearningEnrollmentRow[] = await loadEnrollments(db, access.session);
  const reviewAttempts = cycles.length ? await db.select().from(candidateLearningCourseReviewAttemptsTable).where(and(
    eq(candidateLearningCourseReviewAttemptsTable.candidateId, access.session.candidateId),
    eq(candidateLearningCourseReviewAttemptsTable.tenantId, access.session.tenantId),
  )) : [];
  const reviewLessons = reviewAttempts.length ? await db.select().from(candidateLearningCourseReviewLessonsTable).where(and(
    eq(candidateLearningCourseReviewLessonsTable.candidateId, access.session.candidateId),
    eq(candidateLearningCourseReviewLessonsTable.tenantId, access.session.tenantId),
  )) : [];
  const eligibleCourses = [...new Set(enrollments.filter((row) => row.path === "voice").map((row) => row.courseId))];
  res.json(GetLearningVoiceProgressHomeResponse.parse({
    available: true,
    eligibleCourses,
    cycles: cycles.map((cycle) => {
      const attempt = reviewAttempts.find((row) => row.cycleId === cycle.id);
      const course = getLearningCourse(cycle.courseId);
      const total = course ? courseLessons(course, "voice").length : 0;
      const reviewed = reviewLessons.filter((row) => row.attemptId === attempt?.id).length;
      return voiceCycleSummary(cycle, turns.filter((turn) => turn.cycleId === cycle.id), enrollments, attempt ? { attempt, reviewedCount: reviewed, total } : undefined);
    }),
  }));
});

router.post("/portal/learning-growth/voice-progress", resolveUser, async (req, res): Promise<void> => {
  if (!hasOnlyKeys(req.body, new Set(["courseId"]))) { res.status(400).json({ error: "Invalid voice progress request" }); return; }
  const parsed = StartLearningVoiceProgressCycleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid voice progress request" }); return; }
  const access = await voiceCycleAccess(req, res);
  if (!access || !access.available || ("locked" in access && access.locked)) { if (access?.available) res.status(403).json({ error: access.lockReason }); return; }
  const course = getLearningCourse(parsed.data.courseId);
  const enrollments: LearningEnrollmentRow[] = await loadEnrollments(db, access.session, parsed.data.courseId);
  const enrollment = enrollments.find((row) => row.path === "voice");
  if (!course || !enrollment || course.version !== enrollment.courseVersion) { res.status(404).json({ error: "Voice course not available" }); return; }
  const existing = await db.select().from(candidateLearningVoiceCyclesTable).where(and(
    eq(candidateLearningVoiceCyclesTable.candidateId, access.session.candidateId),
    eq(candidateLearningVoiceCyclesTable.tenantId, access.session.tenantId),
    eq(candidateLearningVoiceCyclesTable.courseId, course.id),
  ));
  let cycle = existing.find((row) => row.state !== "completed");
  if (!cycle) {
    const now = new Date();
    const inserted = await db.insert(candidateLearningVoiceCyclesTable).values({
      id: crypto.randomUUID(), candidateId: access.session.candidateId, tenantId: access.session.tenantId,
      courseId: course.id, courseVersion: course.version,
      comparisonFamilyVersion: VOICE_PROGRESS_COMPARISON_FAMILY_VERSION,
      rubricVersion: VOICE_PROGRESS_RUBRIC_VERSION, evaluatorVersion: VOICE_PROGRESS_EVALUATOR_VERSION,
      state: "baseline_draft", createdAt: now, updatedAt: now,
    }).returning();
    cycle = inserted[0];
  }
  if (!cycle) { res.status(409).json({ error: "Voice progress cycle changed; reload and try again" }); return; }
  const turns = await db.select().from(candidateLearningVoiceTurnsTable).where(and(
    eq(candidateLearningVoiceTurnsTable.cycleId, cycle.id),
    eq(candidateLearningVoiceTurnsTable.candidateId, access.session.candidateId),
    eq(candidateLearningVoiceTurnsTable.tenantId, access.session.tenantId),
  ));
  res.json(StartLearningVoiceProgressCycleResponse.parse(voiceCycleDetail(cycle, turns)));
});

router.get("/portal/learning-growth/voice-progress/:cycleId", resolveUser, async (req, res): Promise<void> => {
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  res.json(GetLearningVoiceProgressCycleResponse.parse(voiceCycleDetail(access.cycle, access.turns)));
});

function trainingReviewDetail(attempt: ReviewAttemptRow, reviewed: ReviewLessonRow[], course: CourseDefinition) {
  const reviewedAt = new Map(reviewed.map((row) => [row.lessonId, row.reviewedAt]));
  const lessons = courseLessons(course, "voice").map((lesson) => ({ id: lesson.id, title: lesson.title, reviewedAt: reviewedAt.get(lesson.id) ?? null }));
  return {
    attemptId: attempt.id, cycleId: attempt.cycleId, courseId: attempt.courseId, status: attempt.status,
    startedAt: attempt.startedAt, completedAt: attempt.completedAt ?? null,
    reviewedCount: reviewed.length, totalLessons: lessons.length, lessons,
  };
}

async function loadTrainingReview(cycleId: string, session: CandidateSession) {
  const [attempt] = await db.select().from(candidateLearningCourseReviewAttemptsTable).where(and(
    eq(candidateLearningCourseReviewAttemptsTable.cycleId, cycleId),
    eq(candidateLearningCourseReviewAttemptsTable.candidateId, session.candidateId),
    eq(candidateLearningCourseReviewAttemptsTable.tenantId, session.tenantId),
  ));
  if (!attempt) return null;
  const reviewed = await db.select().from(candidateLearningCourseReviewLessonsTable).where(and(
    eq(candidateLearningCourseReviewLessonsTable.attemptId, attempt.id),
    eq(candidateLearningCourseReviewLessonsTable.candidateId, session.candidateId),
    eq(candidateLearningCourseReviewLessonsTable.tenantId, session.tenantId),
  ));
  const course = getLearningCourse(attempt.courseId);
  return course ? { attempt, reviewed, course } : null;
}

router.get("/portal/learning-growth/voice-progress/:cycleId/training-review", resolveUser, async (req, res): Promise<void> => {
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  const review = await loadTrainingReview(access.cycle.id, access.session);
  if (!review) { res.status(404).json({ error: "Training review not started" }); return; }
  res.json(GetLearningVoiceTrainingReviewResponse.parse(trainingReviewDetail(review.attempt, review.reviewed, review.course)));
});

router.post("/portal/learning-growth/voice-progress/:cycleId/training-review", resolveUser, async (req, res): Promise<void> => {
  if (!hasOnlyKeys(req.body, new Set())) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const parsed = StartLearningVoiceTrainingReviewBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  const cycle = access.cycle;
  if (cycle.state !== "training" || !cycle.baselineCompletedAt) { res.status(409).json({ error: "Training review is only available after the baseline" }); return; }
  const baselineCompletedAt = cycle.baselineCompletedAt;
  const enrollments: LearningEnrollmentRow[] = await loadEnrollments(db, access.session, cycle.courseId);
  const enrollment = enrollments.find((row) =>
    row.path === "voice" && row.status === "completed" && row.courseVersion === cycle.courseVersion
    && row.completedAt !== null && row.completedAt <= baselineCompletedAt);
  const course = getLearningCourse(cycle.courseId);
  if (!enrollment || !course) { res.status(403).json({ error: "Review the matching completed voice course before starting training review" }); return; }
  const attempt = await db.transaction(async (tx) => {
    const inserted = await tx.insert(candidateLearningCourseReviewAttemptsTable).values({
      id: crypto.randomUUID(), tenantId: access.session.tenantId, candidateId: access.session.candidateId,
      cycleId: cycle.id, courseId: cycle.courseId, courseVersion: cycle.courseVersion,
      status: "in_progress", startedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing({ target: candidateLearningCourseReviewAttemptsTable.cycleId }).returning();
    return inserted[0] ?? (await tx.select().from(candidateLearningCourseReviewAttemptsTable).where(and(
      eq(candidateLearningCourseReviewAttemptsTable.cycleId, cycle.id),
      eq(candidateLearningCourseReviewAttemptsTable.candidateId, access.session.candidateId),
      eq(candidateLearningCourseReviewAttemptsTable.tenantId, access.session.tenantId),
    )))[0];
  });
  if (!attempt) { res.status(409).json({ error: "Training review changed; reload and try again" }); return; }
  const reviewed = await db.select().from(candidateLearningCourseReviewLessonsTable).where(and(eq(candidateLearningCourseReviewLessonsTable.attemptId, attempt.id), eq(candidateLearningCourseReviewLessonsTable.candidateId, access.session.candidateId), eq(candidateLearningCourseReviewLessonsTable.tenantId, access.session.tenantId)));
  res.json(StartLearningVoiceTrainingReviewResponse.parse(trainingReviewDetail(attempt, reviewed, course)));
});

router.put("/portal/learning-growth/voice-progress/:cycleId/training-review/lessons/:lessonId", resolveUser, async (req, res): Promise<void> => {
  if (!hasOnlyKeys(req.body, new Set())) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const parsed = ReviewLearningVoiceTrainingLessonBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  const cycleId = String(req.params.cycleId);
  const lessonId = String(req.params.lessonId);
  const result = await db.transaction(async (tx) => {
    const [cycle] = await tx.select().from(candidateLearningVoiceCyclesTable).where(and(eq(candidateLearningVoiceCyclesTable.id, cycleId), eq(candidateLearningVoiceCyclesTable.candidateId, access.session.candidateId), eq(candidateLearningVoiceCyclesTable.tenantId, access.session.tenantId))).for("update");
    const [attempt] = await tx.select().from(candidateLearningCourseReviewAttemptsTable).where(and(eq(candidateLearningCourseReviewAttemptsTable.cycleId, cycleId), eq(candidateLearningCourseReviewAttemptsTable.candidateId, access.session.candidateId), eq(candidateLearningCourseReviewAttemptsTable.tenantId, access.session.tenantId))).for("update");
    const course = cycle && getLearningCourse(cycle.courseId);
    const lesson = course && cycle && cycle.courseVersion === course.version ? courseLessons(course, "voice").find((item) => item.id === lessonId) : undefined;
    if (!cycle || cycle.state !== "training" || !attempt || attempt.status === "completed" || !course || !lesson) return null;
    await tx.insert(candidateLearningCourseReviewLessonsTable).values({
      id: crypto.randomUUID(), tenantId: access.session.tenantId, candidateId: access.session.candidateId,
      attemptId: attempt.id, lessonId, reviewedAt: new Date(), createdAt: new Date(),
    }).onConflictDoNothing();
    const reviewed = await tx.select().from(candidateLearningCourseReviewLessonsTable).where(and(eq(candidateLearningCourseReviewLessonsTable.attemptId, attempt.id), eq(candidateLearningCourseReviewLessonsTable.candidateId, access.session.candidateId), eq(candidateLearningCourseReviewLessonsTable.tenantId, access.session.tenantId)));
    let finalAttempt = attempt;
    const expectedLessonIds = new Set(courseLessons(course, "voice").map((item) => item.id));
    const reviewedLessonIds = new Set(reviewed.map((row) => row.lessonId));
    const reviewComplete = [...expectedLessonIds].every((expectedId) => reviewedLessonIds.has(expectedId));
    if (reviewComplete) {
      const now = new Date();
      finalAttempt = (await tx.update(candidateLearningCourseReviewAttemptsTable).set({ status: "completed", completedAt: now, updatedAt: now }).where(eq(candidateLearningCourseReviewAttemptsTable.id, attempt.id)).returning())[0] ?? attempt;
      await tx.update(candidateLearningVoiceCyclesTable).set({ trainingCompletedAt: now, trainingEvidence: "tracked_review_attempt", updatedAt: now }).where(and(eq(candidateLearningVoiceCyclesTable.id, cycleId), eq(candidateLearningVoiceCyclesTable.state, "training")));
      await awardLearningReward(tx, {
        candidateId: access.session.candidateId, tenantId: access.session.tenantId,
        eventKey: `${access.session.candidateId}:course-review:${attempt.id}`, eventType: "completed_course_review",
        title: "Training review completed", description: "You reviewed the course lessons before continuing your private learning cycle.",
        badgeKey: "course-review", creditsDelta: 10, sourceType: "course_review", sourceId: attempt.id,
      });
    }
    return { attempt: finalAttempt, reviewed, course };
  });
  if (!result) { res.status(404).json({ error: "Training review lesson not found" }); return; }
  res.json(ReviewLearningVoiceTrainingLessonResponse.parse(trainingReviewDetail(result.attempt, result.reviewed, result.course)));
});

router.post("/portal/learning-growth/voice-progress/:cycleId/complete-training-review", resolveUser, async (req, res): Promise<void> => {
  if (!hasOnlyKeys(req.body, new Set())) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const parsed = CompleteLearningVoiceProgressTrainingReviewBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  if (access.cycle.state !== "training") { res.status(409).json({ error: "Training review is only available after the baseline" }); return; }
  if (access.cycle.trainingEvidence !== "candidate_confirmed_review") {
    res.status(410).json({ error: "Use the tracked training-review endpoint" }); return;
  }
  const cycleId = String(req.params.cycleId);
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(candidateLearningVoiceCyclesTable).where(and(
      eq(candidateLearningVoiceCyclesTable.id, cycleId),
      eq(candidateLearningVoiceCyclesTable.candidateId, access.session.candidateId),
      eq(candidateLearningVoiceCyclesTable.tenantId, access.session.tenantId),
    )).for("update");
    if (!locked || locked.state !== "training" || !locked.baselineCompletedAt) return null;
    const baselineCompletedAt = locked.baselineCompletedAt;
    const enrollments: LearningEnrollmentRow[] = await loadEnrollments(tx, access.session, locked.courseId);
    const matching = enrollments.find((enrollment) =>
      enrollment.path === "voice" && enrollment.status === "completed"
      && enrollment.courseVersion === locked.courseVersion
      && enrollment.completedAt !== null && enrollment.completedAt <= baselineCompletedAt);
    if (!matching) return null;
    const now = new Date();
    const [saved] = await tx.update(candidateLearningVoiceCyclesTable).set({
      trainingCompletedAt: now, trainingEvidence: "candidate_confirmed_review", updatedAt: now,
    }).where(and(
      eq(candidateLearningVoiceCyclesTable.id, cycleId),
      eq(candidateLearningVoiceCyclesTable.state, "training"),
    )).returning();
    return saved ?? null;
  });
  if (!updated) { res.status(403).json({ error: "Review the matching completed voice course before confirming training" }); return; }
  const turns = await db.select().from(candidateLearningVoiceTurnsTable).where(and(
    eq(candidateLearningVoiceTurnsTable.cycleId, cycleId),
    eq(candidateLearningVoiceTurnsTable.candidateId, access.session.candidateId),
    eq(candidateLearningVoiceTurnsTable.tenantId, access.session.tenantId),
  ));
  res.json(CompleteLearningVoiceProgressTrainingReviewResponse.parse(voiceCycleDetail(updated, turns)));
});

router.post("/portal/learning-growth/voice-progress/:cycleId/start-progress", resolveUser, async (req, res): Promise<void> => {
  if (!hasOnlyKeys(req.body, new Set())) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const parsed = StartLearningVoiceProgressBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "This request does not accept fields" }); return; }
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  const cycle = access.cycle;
  if (cycle.state !== "training") { res.status(409).json({ error: "The baseline must be completed before progress can start" }); return; }
  const enrollments: LearningEnrollmentRow[] = await loadEnrollments(db, access.session, cycle.courseId);
  const [enrollment] = enrollments.filter((row) => row.path === "voice" && row.status === "completed");
  const persistedTraining = cycle.trainingCompletedAt !== null
    && cycle.baselineCompletedAt !== null
    && cycle.trainingCompletedAt > cycle.baselineCompletedAt
    && (cycle.trainingEvidence === "candidate_confirmed_review" || cycle.trainingEvidence === "enrollment_completion" || cycle.trainingEvidence === "tracked_review_attempt");
  const postBaselineEnrollment = enrollment?.completedAt !== null
    && enrollment?.completedAt !== undefined
    && cycle.baselineCompletedAt !== null
    && enrollment.completedAt > cycle.baselineCompletedAt
    && enrollment.courseVersion === cycle.courseVersion;
  if ((!persistedTraining && !postBaselineEnrollment) || !enrollment || enrollment.courseVersion !== cycle.courseVersion) {
    res.status(403).json({ error: "Complete the matching voice course after the baseline to unlock the progress interview" }); return;
  }
  const trainingCompletedAt = cycle.trainingCompletedAt ?? new Date();
  const updated = await db.update(candidateLearningVoiceCyclesTable).set({
    state: "progress_draft", progressStartedAt: new Date(),
    trainingCompletedAt, trainingEvidence: cycle.trainingEvidence ?? "enrollment_completion", updatedAt: new Date(),
  }).where(and(
    eq(candidateLearningVoiceCyclesTable.id, cycle.id), eq(candidateLearningVoiceCyclesTable.candidateId, access.session.candidateId),
    eq(candidateLearningVoiceCyclesTable.tenantId, access.session.tenantId), eq(candidateLearningVoiceCyclesTable.state, "training"),
  )).returning();
  if (!updated.length) { res.status(409).json({ error: "Voice progress cycle changed; reload and try again" }); return; }
  const updatedCycle = updated[0];
  if (!updatedCycle) { res.status(409).json({ error: "Voice progress cycle changed; reload and try again" }); return; }
  res.json(StartLearningVoiceProgressResponse.parse(voiceCycleDetail(updatedCycle, access.turns)));
});

router.put("/portal/learning-growth/voice-progress/:cycleId/turns/:taskKey", resolveUser, async (req, res): Promise<void> => {
  if (!hasOnlyKeys(req.body, new Set(["revision", "response", "action"]))) { res.status(400).json({ error: "Invalid voice progress turn request" }); return; }
  const parsed = SaveLearningVoiceProgressTurnBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid voice progress turn request" }); return; }
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  const cycleId = String(req.params.cycleId);
  const taskKey = String(req.params.taskKey);
  try {
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(candidateLearningVoiceCyclesTable).where(and(
        eq(candidateLearningVoiceCyclesTable.id, cycleId), eq(candidateLearningVoiceCyclesTable.candidateId, access.session.candidateId),
        eq(candidateLearningVoiceCyclesTable.tenantId, access.session.tenantId),
      )).for("update");
      if (!locked || locked.state === "completed" || locked.state === "training") throw new RevisionConflict("This voice progress phase is immutable or unavailable");
      const phase: VoiceProgressPhase = locked.state === "progress_draft" ? "progress" : "baseline";
      const form = phase === "baseline" ? "A" : "B";
      const prompt = getVoiceProgressForm(form).prompts.find((item) => item.key === taskKey);
      if (!prompt) throw new RevisionConflict("Voice progress turn not found");
      if (parsed.data.action === "submit" && parsed.data.response.replace(/\s/gu, "").length < prompt.minimumNonSpaceCharacters) throw new TypeError(`Response must contain at least ${prompt.minimumNonSpaceCharacters} non-space characters`);
      const [existing] = await tx.select().from(candidateLearningVoiceTurnsTable).where(and(
        eq(candidateLearningVoiceTurnsTable.cycleId, cycleId), eq(candidateLearningVoiceTurnsTable.candidateId, access.session.candidateId),
        eq(candidateLearningVoiceTurnsTable.tenantId, access.session.tenantId), eq(candidateLearningVoiceTurnsTable.phase, phase),
        eq(candidateLearningVoiceTurnsTable.taskKey, taskKey),
      ));
      if (existing && existing.revision !== parsed.data.revision) throw new RevisionConflict("Voice progress turn changed; reload and try again");
      if (existing?.status === "submitted") throw new RevisionConflict("Submitted voice progress turns are immutable");
      const now = new Date();
      if (!existing) await tx.insert(candidateLearningVoiceTurnsTable).values({
        id: crypto.randomUUID(), cycleId, candidateId: access.session.candidateId, tenantId: access.session.tenantId,
        phase, form, taskKey, revision: 1, status: parsed.data.action === "submit" ? "submitted" : "draft",
        response: parsed.data.response, updatedAt: now, createdAt: now,
      });
      else await tx.update(candidateLearningVoiceTurnsTable).set({
        revision: existing.revision + 1, status: parsed.data.action === "submit" ? "submitted" : "draft",
        response: parsed.data.response, updatedAt: now,
      }).where(and(eq(candidateLearningVoiceTurnsTable.id, existing.id), eq(candidateLearningVoiceTurnsTable.revision, parsed.data.revision)));
      const turns = await tx.select().from(candidateLearningVoiceTurnsTable).where(and(
        eq(candidateLearningVoiceTurnsTable.cycleId, cycleId), eq(candidateLearningVoiceTurnsTable.candidateId, access.session.candidateId),
        eq(candidateLearningVoiceTurnsTable.tenantId, access.session.tenantId), eq(candidateLearningVoiceTurnsTable.phase, phase),
      ));
      let finalCycle = locked;
      const prompts = getVoiceProgressForm(form).prompts;
      if (turns.length === prompts.length && prompts.every((item) => turns.some((turn) => turn.taskKey === item.key && turn.status === "submitted"))) {
        const evaluation = evaluateVoiceProgress(getVoiceProgressForm(form), Object.fromEntries(turns.map((turn) => [turn.taskKey, turn.response])));
        if (phase === "baseline") {
          const updatedCycle = (await tx.update(candidateLearningVoiceCyclesTable).set({ state: "training", baselineSnapshot: evaluation, baselineCompletedAt: now, updatedAt: now }).where(eq(candidateLearningVoiceCyclesTable.id, cycleId)).returning())[0];
          if (!updatedCycle) throw new RevisionConflict("Voice progress cycle changed; reload and try again");
          finalCycle = updatedCycle;
        } else {
          const baseline = locked.baselineSnapshot as ReturnType<typeof evaluateVoiceProgress> | null;
          if (!baseline) throw new RevisionConflict("Comparable baseline is unavailable");
          const comparison = compareVoiceProgress(baseline, evaluation);
          const updatedCycle = (await tx.update(candidateLearningVoiceCyclesTable).set({
            state: "completed", progressSnapshot: evaluation, comparisonSnapshot: comparison, completedAt: now, updatedAt: now,
          }).where(eq(candidateLearningVoiceCyclesTable.id, cycleId)).returning())[0];
          if (!updatedCycle) throw new RevisionConflict("Voice progress cycle changed; reload and try again");
          await awardLearningReward(tx, {
            candidateId: access.session.candidateId, tenantId: access.session.tenantId,
            eventKey: `${access.session.candidateId}:voice-growth:first`, eventType: "completed_voice_growth",
            title: "Voice growth cycle completed", description: "You completed a private voice progress cycle.",
            badgeKey: "voice-growth", creditsDelta: 50, sourceType: "voice_progress", sourceId: cycleId,
          });
          finalCycle = updatedCycle;
        }
      }
      const allTurns = await tx.select().from(candidateLearningVoiceTurnsTable).where(and(eq(candidateLearningVoiceTurnsTable.cycleId, cycleId), eq(candidateLearningVoiceTurnsTable.candidateId, access.session.candidateId), eq(candidateLearningVoiceTurnsTable.tenantId, access.session.tenantId)));
      return { cycle: finalCycle, turns: allTurns };
    });
    res.json(SaveLearningVoiceProgressTurnResponse.parse(voiceCycleDetail(result.cycle, result.turns)));
  } catch (error) {
    if (error instanceof RevisionConflict) { res.status(409).json({ code: "revision_conflict", error: error.message }); return; }
    if (error instanceof TypeError) { res.status(400).json({ error: error.message }); return; }
    throw error;
  }
});

router.get("/portal/learning-growth/voice-progress/:cycleId/report", resolveUser, async (req, res): Promise<void> => {
  const access = await voiceCycleAccess(req, res, String(req.params.cycleId));
  if (!access || !("cycle" in access) || !access.cycle) return;
  if (access.cycle.state !== "completed" || !access.cycle.comparisonSnapshot || !access.cycle.baselineSnapshot || !access.cycle.progressSnapshot) { res.status(409).json({ error: "Voice progress cycle is not completed" }); return; }
  const report = {
    summary: voiceCycleSummary(access.cycle, access.turns),
    comparison: access.cycle.comparisonSnapshot,
    baseline: access.cycle.baselineSnapshot,
    progress: access.cycle.progressSnapshot,
    recommendations: [...new Set((access.cycle.progressSnapshot as { recommendations?: string[] }).recommendations ?? [])],
  };
  res.json(GetLearningVoiceProgressReportResponse.parse(report));
});

router.get("/portal/learning-growth/achievements", resolveUser, async (req, res): Promise<void> => {
  const session = await ownerSession(req, res);
  if (!session) return;
  const ledger = await db.select().from(candidateLearningRewardLedgerTable).where(and(
    eq(candidateLearningRewardLedgerTable.candidateId, session.candidateId),
    eq(candidateLearningRewardLedgerTable.tenantId, session.tenantId),
  ));
  const completedCourses = await db.select().from(candidateLearningEnrollmentsTable).where(and(
    eq(candidateLearningEnrollmentsTable.candidateId, session.candidateId),
    eq(candidateLearningEnrollmentsTable.tenantId, session.tenantId),
    eq(candidateLearningEnrollmentsTable.status, "completed"),
  ));
  const completedAssessments = await db.select().from(candidateLearningAssessmentsTable).where(and(
    eq(candidateLearningAssessmentsTable.candidateId, session.candidateId),
    eq(candidateLearningAssessmentsTable.tenantId, session.tenantId),
    eq(candidateLearningAssessmentsTable.status, "completed"),
  ));
  const completedGrowth = await db.select().from(candidateLearningVoiceCyclesTable).where(and(
    eq(candidateLearningVoiceCyclesTable.candidateId, session.candidateId),
    eq(candidateLearningVoiceCyclesTable.tenantId, session.tenantId),
    eq(candidateLearningVoiceCyclesTable.state, "completed"),
  ));
  const badges = [...new Map(ledger.filter((row) => row.badgeKey)
    .sort((a, b) => a.earnedAt.getTime() - b.earnedAt.getTime() || a.id.localeCompare(b.id))
    .map((row) => [row.badgeKey!, { key: row.badgeKey!, title: row.title, description: row.description, earnedAt: row.earnedAt }] as const)).values()];
  const recentActivity = [...ledger]
    .sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime() || a.id.localeCompare(b.id))
    .slice(0, 20)
    .map((row) => ({ id: row.id, eventType: row.eventType, title: row.title, description: row.description, creditsDelta: row.creditsDelta, earnedAt: row.earnedAt }));
  res.json(GetLearningAchievementsResponse.parse({
    creditsBalance: ledger.reduce((sum, row) => sum + row.creditsDelta, 0),
    creditLabel: "Learning credits",
    nonMonetaryDisclaimer: "Learning credits are recognition points only. They have no cash value, cannot be transferred or purchased, do not expire, and cannot be reused as billing credit.",
    badges,
    recentActivity,
    milestones: [
      { key: "first-course", title: "Complete your first course", target: 1, current: Math.min(completedCourses.length, 1), completed: completedCourses.length >= 1 },
      { key: "courses", title: "Complete learning courses", target: 3, current: completedCourses.length, completed: completedCourses.length >= 3 },
      { key: "assessment", title: "Complete a structured reassessment", target: 1, current: Math.min(completedAssessments.length, 1), completed: completedAssessments.length >= 1 },
      { key: "voice-growth", title: "Complete a private voice growth cycle", target: 1, current: Math.min(completedGrowth.length, 1), completed: completedGrowth.length >= 1 },
    ],
  }));
});

export default router;