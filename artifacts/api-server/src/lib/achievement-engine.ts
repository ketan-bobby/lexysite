/**
 * achievement-engine.ts — Candidate Achievement Awarding
 *
 * Pure, idempotent function that inspects a candidate's current state and
 * awards any new achievements they qualify for. Run lazily whenever the
 * candidate hits a major endpoint (dashboard, interview complete, application
 * submitted) — the unique (candidate_id, code) index makes re-runs safe.
 *
 * Adding a new badge: append to ACHIEVEMENT_DEFS and (optionally) extend the
 * stat-collection block in evaluateCandidate(). No other wiring required.
 */
import { db } from "@workspace/db";
import {
  candidateAchievementsTable,
  candidatesTable,
  candidateCareerProfilesTable,
  candidateActivityStreaksTable,
  candidateActionEventsTable,
  candidateProgressSnapshotsTable,
  applicationsTable,
  interviewSessionsTable,
} from "@workspace/db";
import { eq, and, sql, desc, gte } from "drizzle-orm";
import { logger } from "./logger.js";
import { getViewerPrivacySeal, countSealedRecruiterViews } from "./viewer-privacy.js";

export interface AchievementDef {
  code: string;
  title: string;
  description: string;
  icon: string;        // lucide icon name (frontend resolves)
  qualifies: (s: CandidateStats) => boolean;
}

export interface CandidateStats {
  candidateId: string;
  profileCompleteness: number;
  readinessScore: number;
  hasResume: boolean;
  baselineInterviewDone: boolean;
  mockInterviewsCompleted: number;
  applicationsSubmitted: number;
  recruiterViewsAllTime: number;
  currentStreak: number;
  longestStreak: number;
  totalSessions: number;
  daysSinceJoin: number;
  /* Movement signal — change in readinessScore over the last ~30 days, computed
     from candidate_progress_snapshots. Kept around as a secondary signal but
     no longer drives Climber (band-based delta below is the brochure-aligned
     metric). Null when we don't have a 30-day-old baseline yet. */
  readinessScoreMonthlyDelta: number | null;
  /* Mocks completed in the trailing 14 days — drives the "Five In A Row"
     ("Practice Pro") badge per the Achievements brochure slide ("Five mocks
     in two weeks"). */
  mockInterviewsLast14Days: number;
  /* Peer percentile (global) movement over the last ~90 days — drives the
     "Climber" badge per the Achievements brochure slide ("Skill score moved
     up two bands this quarter"). Two bands ≈ a 10-point percentile jump.
     Null when we don't have a 75-105 day-old baseline snapshot. */
  peerPctGlobalQuarterlyDelta: number | null;
}

export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  {
    code: "first_steps",
    title: "First Steps",
    description: "You created your Lexy profile — welcome aboard!",
    icon: "sparkles",
    qualifies: (s) => s.daysSinceJoin >= 0,
  },
  {
    code: "resume_uploaded",
    title: "Resume in Hand",
    description: "Your resume is uploaded and ready for AI matching.",
    icon: "file-text",
    qualifies: (s) => s.hasResume,
  },
  {
    code: "first_interview",
    title: "Interview Pioneer",
    description: "You completed your AI baseline interview.",
    icon: "mic",
    qualifies: (s) => s.baselineInterviewDone,
  },
  {
    code: "profile_complete",
    title: "Profile Polished",
    description: "Your profile is 100% complete — recruiters love this.",
    icon: "check-circle-2",
    qualifies: (s) => s.profileCompleteness >= 100,
  },
  {
    code: "profile_strong",
    title: "Strong Foundation",
    description: "Your profile is 80%+ complete.",
    icon: "shield",
    qualifies: (s) => s.profileCompleteness >= 80,
  },
  {
    code: "five_mocks",
    title: "Five In A Row",
    description: "Five mocks in two weeks — consistency is the unlock, you've found yours.",
    icon: "target",
    qualifies: (s) => s.mockInterviewsLast14Days >= 5,
  },
  {
    code: "ten_mocks",
    title: "Interview Athlete",
    description: "10 mock interviews and counting — you're in elite company.",
    icon: "trophy",
    qualifies: (s) => s.mockInterviewsCompleted >= 10,
  },
  {
    code: "first_application",
    title: "On the Hunt",
    description: "You submitted your first application through Lexy.",
    icon: "send",
    qualifies: (s) => s.applicationsSubmitted >= 1,
  },
  {
    code: "applications_five",
    title: "Active Applicant",
    description: "Five applications submitted — momentum is building.",
    icon: "rocket",
    qualifies: (s) => s.applicationsSubmitted >= 5,
  },
  {
    code: "in_demand",
    title: "In Demand",
    description: "10+ recruiters viewed your profile.",
    icon: "eye",
    qualifies: (s) => s.recruiterViewsAllTime >= 10,
  },
  {
    code: "highly_visible",
    title: "Highly Visible",
    description: "50+ recruiters viewed your profile — your visibility is paying off.",
    icon: "star",
    qualifies: (s) => s.recruiterViewsAllTime >= 50,
  },
  {
    code: "week_streak",
    title: "Week Warrior",
    description: "7-day activity streak. Consistency wins.",
    icon: "flame",
    qualifies: (s) => s.longestStreak >= 7,
  },
  {
    code: "month_streak",
    title: "Unstoppable",
    description: "30-day activity streak — you're in the top 1% for consistency.",
    icon: "flame",
    qualifies: (s) => s.longestStreak >= 30,
  },
  {
    code: "ready_to_hire",
    title: "Ready to Hire",
    description: "Your readiness score crossed 75 — you're hiring-ready.",
    icon: "zap",
    qualifies: (s) => s.readinessScore >= 75,
  },
  {
    /* Brochure: Achievements slide → "Climber" → "Skill score moved up two
       bands this quarter. The line goes up." Bands are derived from peer
       percentile, so a "two band" jump corresponds to roughly +10 percentile
       points. Snapshot-to-snapshot delta over a 75-105 day window — null
       when either endpoint snapshot is missing, so brand-new candidates and
       stale baselines never fire it. */
    code: "climber",
    title: "Climber",
    description: "Skill score moved up two bands this quarter. The line goes up.",
    icon: "trending-up",
    qualifies: (s) => s.peerPctGlobalQuarterlyDelta !== null && s.peerPctGlobalQuarterlyDelta >= 10,
  },
];

async function gatherStats(candidateId: string): Promise<CandidateStats> {
  const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  const [profile] = await db.select().from(candidateCareerProfilesTable)
    .where(eq((candidateCareerProfilesTable as any).candidateId, candidateId)).limit(1);
  const [streak] = await db.select().from(candidateActivityStreaksTable)
    .where(eq(candidateActivityStreaksTable.candidateId, candidateId)).limit(1);

  const [{ count: mockInterviewsCompleted = 0 } = {}] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(candidateActionEventsTable)
    .where(and(
      eq(candidateActionEventsTable.candidateId, candidateId),
      eq(candidateActionEventsTable.eventType, "mock_interview_completed"),
    ));

  /* Trailing-14-day mock count — drives Five In A Row ("Practice Pro").
     Brochure: "Five mocks in two weeks. Consistency is the unlock." */
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
  const [{ count: mockInterviewsLast14Days = 0 } = {}] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(candidateActionEventsTable)
    .where(and(
      eq(candidateActionEventsTable.candidateId, candidateId),
      eq(candidateActionEventsTable.eventType, "mock_interview_completed"),
      gte(candidateActionEventsTable.createdAt, fourteenDaysAgo),
    ));

  const [{ count: applicationsSubmitted = 0 } = {}] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(applicationsTable)
    .where(eq((applicationsTable as any).candidateId, candidateId));

  /* Viewer-privacy seal (lib/viewer-privacy.ts): view-driven badges are a
     candidate-facing "you were seen" surface — paused → views don't qualify,
     blocked/hidden viewer tenants excluded. Already-awarded badges persist. */
  const viewerSeal = await getViewerPrivacySeal(candidateId);
  const recruiterViewsAllTime = await countSealedRecruiterViews(candidateId, null, viewerSeal);

  const [{ count: baselineInterviewCount = 0 } = {}] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(interviewSessionsTable)
    .where(and(
      eq((interviewSessionsTable as any).candidateId, candidateId),
      eq((interviewSessionsTable as any).status, "completed"),
    ));

  const createdAt = (cand as any)?.createdAt ? new Date((cand as any).createdAt) : new Date();
  const daysSinceJoin = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86_400_000));

  /* Monthly readiness-score delta — drives the "Climber" badge.
     Strictly snapshot-to-snapshot: latest snapshot's readinessScore minus the
     most recent snapshot inside a 21-45 day-old WINDOW (so "this month" is
     bounded — months-old baselines don't count). Null when either the
     "current" snapshot or the windowed baseline is missing — that prevents
     awarding Climber to brand-new candidates and prevents false positives
     from stale baselines. The profile's live readinessScore is intentionally
     NOT used here (review feedback: profile-vs-snapshot mixing made the
     delta semantics ambiguous). */
  const currentReadiness =
    (profile as any)?.readinessScore ?? (profile as any)?.preparationLevel ?? 0;
  let readinessScoreMonthlyDelta: number | null = null;
  try {
    const windowEnd   = new Date(Date.now() - 21 * 86_400_000); // ≥21d old
    const windowStart = new Date(Date.now() - 45 * 86_400_000); // ≤45d old
    const [latestSnap] = await db
      .select({ readinessScore: candidateProgressSnapshotsTable.readinessScore })
      .from(candidateProgressSnapshotsTable)
      .where(eq(candidateProgressSnapshotsTable.candidateId, candidateId))
      .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
      .limit(1);
    const [baselineSnap] = await db
      .select({ readinessScore: candidateProgressSnapshotsTable.readinessScore })
      .from(candidateProgressSnapshotsTable)
      .where(and(
        eq(candidateProgressSnapshotsTable.candidateId, candidateId),
        sql`${candidateProgressSnapshotsTable.createdAt} <= ${windowEnd}`,
        sql`${candidateProgressSnapshotsTable.createdAt} >= ${windowStart}`,
      ))
      .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
      .limit(1);
    if (
      latestSnap && typeof latestSnap.readinessScore === "number" &&
      baselineSnap && typeof baselineSnap.readinessScore === "number"
    ) {
      readinessScoreMonthlyDelta = latestSnap.readinessScore - baselineSnap.readinessScore;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, candidateId }, "[achievements] monthly delta lookup failed");
  }

  /* Quarterly peer-percentile-global delta — drives the "Climber" badge per
     the brochure ("Skill score moved up two bands this quarter"). Bands are
     derived from peerPctGlobal, so a "two band" jump ≈ +10 percentile points.
     Snapshot-to-snapshot in a 75-105 day window. Null if either endpoint
     snapshot is missing or has a null peerPctGlobal — so brand-new candidates
     and stale baselines never fire it. */
  let peerPctGlobalQuarterlyDelta: number | null = null;
  try {
    const qWindowEnd   = new Date(Date.now() - 75 * 86_400_000);
    const qWindowStart = new Date(Date.now() - 105 * 86_400_000);
    const [latestPeer] = await db
      .select({ peerPctGlobal: candidateProgressSnapshotsTable.peerPctGlobal })
      .from(candidateProgressSnapshotsTable)
      .where(and(
        eq(candidateProgressSnapshotsTable.candidateId, candidateId),
        sql`${candidateProgressSnapshotsTable.peerPctGlobal} IS NOT NULL`,
      ))
      .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
      .limit(1);
    const [baselinePeer] = await db
      .select({ peerPctGlobal: candidateProgressSnapshotsTable.peerPctGlobal })
      .from(candidateProgressSnapshotsTable)
      .where(and(
        eq(candidateProgressSnapshotsTable.candidateId, candidateId),
        sql`${candidateProgressSnapshotsTable.peerPctGlobal} IS NOT NULL`,
        sql`${candidateProgressSnapshotsTable.createdAt} <= ${qWindowEnd}`,
        sql`${candidateProgressSnapshotsTable.createdAt} >= ${qWindowStart}`,
      ))
      .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
      .limit(1);
    if (
      latestPeer && typeof latestPeer.peerPctGlobal === "number" &&
      baselinePeer && typeof baselinePeer.peerPctGlobal === "number"
    ) {
      peerPctGlobalQuarterlyDelta = latestPeer.peerPctGlobal - baselinePeer.peerPctGlobal;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, candidateId }, "[achievements] quarterly band delta lookup failed");
  }

  return {
    candidateId,
    profileCompleteness: (profile as any)?.profileCompleteness ?? 0,
    readinessScore: currentReadiness,
    hasResume: Boolean((cand as any)?.resumeUrl || (profile as any)?.parsedResume),
    baselineInterviewDone: baselineInterviewCount > 0 || Boolean((profile as any)?.baselineCompletedAt),
    mockInterviewsCompleted,
    mockInterviewsLast14Days,
    applicationsSubmitted,
    recruiterViewsAllTime,
    currentStreak: streak?.currentStreak ?? 0,
    longestStreak: streak?.longestStreak ?? 0,
    totalSessions: streak?.totalSessions ?? 0,
    daysSinceJoin,
    readinessScoreMonthlyDelta,
    peerPctGlobalQuarterlyDelta,
  };
}

/**
 * Awards any newly-qualified achievements to the candidate.
 * Returns a list of achievements that were awarded in THIS call (i.e. brand
 * new — used by the dashboard to show a celebration toast / pulse).
 */
export async function awardAchievements(candidateId: string): Promise<{ code: string; title: string; description: string; icon: string }[]> {
  let stats: CandidateStats;
  try {
    stats = await gatherStats(candidateId);
  } catch (err: any) {
    logger.warn({ err: err?.message, candidateId }, "[achievements] stats gather failed");
    return [];
  }

  const existing = await db
    .select({ code: candidateAchievementsTable.code })
    .from(candidateAchievementsTable)
    .where(eq(candidateAchievementsTable.candidateId, candidateId));
  const haveSet = new Set(existing.map(e => e.code));

  const newlyEarned: { code: string; title: string; description: string; icon: string }[] = [];

  for (const def of ACHIEVEMENT_DEFS) {
    if (haveSet.has(def.code)) continue;
    if (!def.qualifies(stats)) continue;
    try {
      /* Use .returning() so we only push to newlyEarned when the row is
         actually inserted (not silently swallowed by the unique-constraint
         conflict, e.g. a concurrent dashboard hit). This makes the return
         value semantically idempotent — repeated calls for the same candidate
         under contention won't duplicate "you earned X!" toasts. */
      const inserted = await db
        .insert(candidateAchievementsTable)
        .values({
          candidateId,
          code: def.code,
          title: def.title,
          description: def.description,
          icon: def.icon,
        } as any)
        .onConflictDoNothing({ target: [candidateAchievementsTable.candidateId, candidateAchievementsTable.code] })
        .returning({ id: candidateAchievementsTable.id });
      if (inserted.length > 0) {
        newlyEarned.push({ code: def.code, title: def.title, description: def.description, icon: def.icon });
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, code: def.code }, "[achievements] insert failed");
    }
  }

  if (newlyEarned.length > 0) {
    logger.info({ candidateId, codes: newlyEarned.map(a => a.code) }, "[achievements] awarded");
  }
  return newlyEarned;
}

/** Returns ALL achievements for a candidate, with earned status. */
export async function listAchievements(candidateId: string) {
  const earned = await db
    .select()
    .from(candidateAchievementsTable)
    .where(eq(candidateAchievementsTable.candidateId, candidateId))
    .orderBy(desc(candidateAchievementsTable.earnedAt));

  const earnedByCode = new Map(earned.map(e => [e.code, e]));

  return ACHIEVEMENT_DEFS.map(def => ({
    code: def.code,
    title: def.title,
    description: def.description,
    icon: def.icon,
    earned: earnedByCode.has(def.code),
    earnedAt: earnedByCode.get(def.code)?.earnedAt ?? null,
  }));
}
