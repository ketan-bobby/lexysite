/**
 * candidateConnectionEngine.ts — Candidate-Side Hiring Momentum Engine
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Tracks a candidate's engagement signals and calculates two scores that are
 * shown ONLY to the candidate in their portal — giving them encouraging, actionable
 * feedback about how their application is progressing.
 *
 *   connectionStrengthScore  (0–100)  — how actively engaged the candidate is
 *   hiringMomentumScore      (0–100)  — strength × breadth-of-engagement bonus
 *
 * ─── Design principles ───────────────────────────────────────────────────────
 * This engine is deliberately CANDIDATE-FACING and supportive:
 *   • Never auto-rejects candidates
 *   • Never hides jobs from candidates
 *   • Never influences employer-side rankings or scoring
 *   • Never writes to the employer-side connection_events / connection_scores tables
 *   • All labels and next-best-action messages are encouraging, never judgmental
 *
 * ─── Event weights ───────────────────────────────────────────────────────────
 * Positive events (things the candidate did to show momentum):
 *   completed_ai_interview  +20    completed_interview  +20
 *   booked_interview        +18    accepted_intro       +15
 *   replied_to_message      +12    responded_quickly    +10
 *   completed_profile       +10    followed_up           +8
 *   viewed_opportunity       +5
 * Negative events (disengagement signals):
 *   no_show                 -25    declined_role        -20    long_silence  -10
 *
 * ─── Scoring flow ────────────────────────────────────────────────────────────
 *   recordCandidateConnectionEvent()    Write a raw event
 *       ↓
 *   recalculateCandidateInsights()      Calculate both scores + nextBestAction,
 *                                       upsert to candidate_connection_insights
 *       ↓
 *   getCandidateConnectionInsight()     Read the latest stored insight for display
 *
 * ─── Feature flag ────────────────────────────────────────────────────────────
 * Controlled by ENABLE_CANDIDATE_CONNECTION_ENGINE=true env var.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   routes/candidate-connection-engine.ts — event recording + insight retrieval
 *   routes/candidates.ts                  — enriches candidate portal profile
 */

// ── CANDIDATE CONNECTION ENGINE ───────────────────────────────────────────────
// Candidate-side only. Provides supportive, encouraging signals for candidates.

import { db } from "@workspace/db";
import {
  candidateConnectionEventsTable,
  candidateConnectionInsightsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { sumWeightsClamped, topSignalsByWeight } from "./scoring-core.js";

// ─── Event weights (candidate-side perspective) ───────────────────────────────
// Positive signals: things the candidate did to show interest / momentum
// Negative signals: things that might indicate disengagement
const EVENT_WEIGHTS: Record<string, number> = {
  viewed_opportunity:        5,
  replied_to_message:       12,
  responded_quickly:        10,
  completed_profile:        10,
  completed_ai_interview:   20,
  booked_interview:         18,
  completed_interview:      20,
  accepted_intro:           15,
  followed_up:               8,
  // Negative (disengagement signals)
  no_show:                 -25,
  declined_role:           -20,
  long_silence:            -10,
};

// ─── Hiring momentum thresholds ──────────────────────────────────────────────
// Based on connection strength score (0–100)
function momentumLabel(score: number): "Low" | "Medium" | "High" | "Very High" {
  if (score <= 25)  return "Low";
  if (score <= 55)  return "Medium";
  if (score <= 80)  return "High";
  return "Very High";
}

function strengthLabel(score: number): "Cold" | "Warming" | "Engaged" | "High Intent" {
  if (score <= 30) return "Cold";
  if (score <= 60) return "Warming";
  if (score <= 80) return "Engaged";
  return "High Intent";
}

// ─── Next Best Action ─────────────────────────────────────────────────────────
// Supportive, encouraging, never judgmental.
function nextBestAction(
  score: number,
  events: { eventType: string }[],
  hasInterview: boolean,
  hasProfile: boolean,
): string {
  const types = new Set(events.map(e => e.eventType));

  if (types.has("no_show")) {
    return "Follow up with the recruiter — re-engaging now can help get your application back on track.";
  }
  if (types.has("declined_role")) {
    return "Explore other open roles that might be a better fit for your goals.";
  }
  if (!hasProfile) {
    return "Complete your career profile to help recruiters understand your strengths and goals.";
  }
  if (!hasInterview && !types.has("completed_ai_interview")) {
    return "Complete your AI interview to improve your chances — it's the fastest way to stand out.";
  }
  if (!types.has("booked_interview") && !types.has("completed_interview")) {
    return "Reply to the recruiter to keep your momentum — responsiveness signals genuine interest.";
  }
  if (types.has("booked_interview") && !types.has("completed_interview")) {
    return "You have an interview scheduled — review the job details and prepare your key talking points.";
  }
  if (types.has("completed_interview")) {
    if (score >= 75) return "You've completed all steps — stay responsive and watch for updates. You're in a strong position.";
    return "You've completed the interview — a quick follow-up note can help you stay top of mind.";
  }
  if (score >= 60) {
    return "This opportunity is warming up — stay engaged and keep your profile current.";
  }
  if (score >= 30) {
    return "You're building traction here — replying promptly and staying active will help your momentum.";
  }
  return "Start engaging with this opportunity — view the job details and send a message to get noticed.";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Record a new candidate-side connection event. */
export async function recordCandidateConnectionEvent(data: {
  candidateId: string;
  eventType: string;
  jobId?: string | null;
  employerId?: string | null;
  eventValue?: string | null;
  metadata?: Record<string, any> | null;
}) {
  const [event] = await db
    .insert(candidateConnectionEventsTable)
    .values({
      id: crypto.randomUUID(),
      candidateId: data.candidateId,
      eventType: data.eventType,
      jobId: data.jobId ?? undefined,
      employerId: data.employerId ?? undefined,
      eventValue: data.eventValue ?? undefined,
      metadata: data.metadata ?? undefined,
    })
    .returning();
  return event;
}

/** Calculate connection strength score from stored events. Caps 0–100. */
export function calculateCandidateConnectionStrength(
  events: { eventType: string }[],
): { score: number; label: "Cold" | "Warming" | "Engaged" | "High Intent" } {
  const score = sumWeightsClamped(events, EVENT_WEIGHTS);
  return { score, label: strengthLabel(score) };
}

/** Derive hiring momentum from the same signals. */
export function calculateCandidateHiringMomentum(
  score: number,
  events: { eventType: string }[],
): { score: number; label: "Low" | "Medium" | "High" | "Very High" } {
  // Give a small bonus for variety (breadth of engagement)
  const uniquePositiveTypes = new Set(
    events
      .filter(e => (EVENT_WEIGHTS[e.eventType] ?? 0) > 0)
      .map(e => e.eventType)
  ).size;
  const diversityBonus = Math.min(10, uniquePositiveTypes * 2);
  const momentumRaw = Math.min(100, Math.max(0, score + diversityBonus));
  return { score: momentumRaw, label: momentumLabel(momentumRaw) };
}

/** Determine top contributing signals for display. */
export function topCandidateSignals(events: { eventType: string }[]): string[] {
  // Candidate-side skips unweighted event types (unlike the employer engine).
  return topSignalsByWeight(events, EVENT_WEIGHTS, { skipZeroWeight: true });
}

/** Compute and upsert a CandidateConnectionInsight record. */
export async function recalculateCandidateInsights(
  candidateId: string,
  jobId?: string | null,
  employerId?: string | null,
  context?: { hasInterview?: boolean; hasProfile?: boolean },
): Promise<{
  connectionStrengthScore: number;
  connectionStrengthLabel: string;
  hiringMomentumScore: number;
  hiringMomentumLabel: string;
  nextBestAction: string;
  topSignals: string[];
}> {
  const conditions = [eq(candidateConnectionEventsTable.candidateId, candidateId)];
  if (jobId) conditions.push(eq(candidateConnectionEventsTable.jobId, jobId));

  const events = await db
    .select()
    .from(candidateConnectionEventsTable)
    .where(and(...conditions))
    .orderBy(desc(candidateConnectionEventsTable.createdAt));

  const { score: strengthScore, label: strengthLbl } = calculateCandidateConnectionStrength(events);
  const { score: momentumScore, label: momentumLbl } = calculateCandidateHiringMomentum(strengthScore, events);
  const action = nextBestAction(
    strengthScore,
    events,
    context?.hasInterview ?? false,
    context?.hasProfile ?? true,
  );
  const signals = topCandidateSignals(events);

  // Upsert the insight record
  const insightConditions = [eq(candidateConnectionInsightsTable.candidateId, candidateId)];
  if (jobId) insightConditions.push(eq(candidateConnectionInsightsTable.jobId, jobId));

  const [existing] = await db
    .select()
    .from(candidateConnectionInsightsTable)
    .where(and(...insightConditions))
    .limit(1);

  const insightData = {
    connectionStrengthScore: strengthScore,
    connectionStrengthLabel: strengthLbl,
    hiringMomentumScore: momentumScore,
    hiringMomentumLabel: momentumLbl,
    nextBestAction: action,
    topSignals: signals,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(candidateConnectionInsightsTable)
      .set(insightData)
      .where(eq(candidateConnectionInsightsTable.id, existing.id));
  } else {
    await db.insert(candidateConnectionInsightsTable).values({
      id: crypto.randomUUID(),
      candidateId,
      jobId: jobId ?? undefined,
      employerId: employerId ?? undefined,
      ...insightData,
    });
  }

  return {
    connectionStrengthScore: strengthScore,
    connectionStrengthLabel: strengthLbl,
    hiringMomentumScore: momentumScore,
    hiringMomentumLabel: momentumLbl,
    nextBestAction: action,
    topSignals: signals,
  };
}

/** Fetch all stored insights for a candidate (all jobs). */
export async function getCandidateConnectionInsights(candidateId: string) {
  return db
    .select()
    .from(candidateConnectionInsightsTable)
    .where(eq(candidateConnectionInsightsTable.candidateId, candidateId))
    .orderBy(desc(candidateConnectionInsightsTable.updatedAt));
}

/** Fetch insight for a specific candidate + job. */
export async function getCandidateConnectionInsight(candidateId: string, jobId: string) {
  const [row] = await db
    .select()
    .from(candidateConnectionInsightsTable)
    .where(
      and(
        eq(candidateConnectionInsightsTable.candidateId, candidateId),
        eq(candidateConnectionInsightsTable.jobId, jobId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Candidate-friendly display labels for raw event type keys. */
export const CANDIDATE_EVENT_LABELS: Record<string, string> = {
  viewed_opportunity:      "Viewed this opportunity",
  replied_to_message:      "Replied to recruiter",
  responded_quickly:       "Responded within 24 hours",
  completed_profile:       "Completed career profile",
  completed_ai_interview:  "Completed AI interview",
  booked_interview:        "Booked an interview",
  completed_interview:     "Completed interview",
  accepted_intro:          "Accepted intro",
  followed_up:             "Sent a follow-up",
  no_show:                 "Missed a scheduled session",
  declined_role:           "Declined this role",
  long_silence:            "No activity for a while",
};

/** All valid event types for the candidate connection engine. */
export const VALID_CANDIDATE_EVENT_TYPES = Object.keys(EVENT_WEIGHTS);
