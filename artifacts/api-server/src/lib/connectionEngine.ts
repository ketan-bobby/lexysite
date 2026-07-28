/**
 * connectionEngine.ts — Employer-Side Connection Strength Scoring
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Calculates a connectionStrengthScore (0–100) for a candidate–employer
 * (and optionally candidate–job) relationship from raw behavioural events.
 * This score reflects the employer's view of engagement quality and is
 * displayed to recruiters in the candidate profile and pipeline views.
 *
 * ─── Event weights ───────────────────────────────────────────────────────────
 * Positive signals accumulate score; negative signals subtract it.
 * The score is always clamped to [0, 100].
 *   replied_to_outreach   +15    response_within_24h  +10
 *   accepted_intro        +15    booked_interview     +20
 *   completed_interview   +20    viewed_opportunity    +5
 *   multiple_interactions +10
 *   no_show              -25    declined_role         -20
 *
 * ─── Scoring flow ────────────────────────────────────────────────────────────
 *   recordConnectionEvent()         Write a raw event to connection_events
 *       ↓
 *   recalculateConnectionScore()    Sum all event weights, clamp, upsert to
 *                                   connection_scores (one row per candidate+job)
 *       ↓
 *   getConnectionScore()            Read the latest stored score; falls back
 *                                   to the candidate-level score if no job row exists
 *
 * ─── Important boundary ──────────────────────────────────────────────────────
 * This is the EMPLOYER-SIDE engine. It writes to connection_events and
 * connection_scores tables. The CANDIDATE-SIDE equivalent (candidateConnectionEngine.ts)
 * writes to candidate_connection_events and candidate_connection_insights.
 * The two systems are completely independent and must not be mixed.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   routes/candidate-connection-engine.ts — event recording + score retrieval APIs
 *   routes/candidates.ts                  — enriches candidate profile responses
 */

// ── CONNECTION ENGINE SERVICE ─────────────────────────────────────────────────
// Additive module. Calculates a connectionStrengthScore (0–100) from
// behavioural signals. Does NOT modify any existing scoring logic.

import { db } from "@workspace/db";
import { connectionEventsTable, connectionScoresTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { sumWeightsClamped, topSignalsByWeight } from "./scoring-core.js";

// ─── Event weights ────────────────────────────────────────────────────────────
const EVENT_WEIGHTS: Record<string, number> = {
  replied_to_outreach:   15,
  response_within_24h:   10,
  accepted_intro:        15,
  booked_interview:      20,
  completed_interview:   20,
  viewed_opportunity:     5,
  multiple_interactions: 10,
  no_show:              -25,
  declined_role:        -20,
};

// ─── Public helpers ───────────────────────────────────────────────────────────

/** Record a single employer-side connection event. */
export async function recordConnectionEvent(data: {
  candidateId: string;
  eventType: string;
  jobId?: string | null;
  employerId?: string | null;
  eventValue?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await db.insert(connectionEventsTable).values({
    candidateId: data.candidateId,
    eventType: data.eventType,
    jobId: data.jobId ?? undefined,
    employerId: data.employerId ?? undefined,
    eventValue: data.eventValue ?? undefined,
    metadata: data.metadata ?? undefined,
  });
}

/** Fetch all events for a candidate (optionally scoped to a job). */
export async function getConnectionEvents(
  candidateId: string,
  jobId?: string,
) {
  const conditions = [eq(connectionEventsTable.candidateId, candidateId)];
  if (jobId) conditions.push(eq(connectionEventsTable.jobId, jobId));
  return db.select().from(connectionEventsTable).where(and(...conditions));
}

/** Calculate and persist a ConnectionStrengthScore from stored events. */
export async function recalculateConnectionScore(
  candidateId: string,
  jobId?: string | null,
  employerId?: string | null,
): Promise<number> {
  const conditions = [eq(connectionEventsTable.candidateId, candidateId)];
  if (jobId) conditions.push(eq(connectionEventsTable.jobId, jobId));

  const events = await db
    .select()
    .from(connectionEventsTable)
    .where(and(...conditions));

  // Sum weights, clamp to [0, 100] (shared scaffolding — scoring-core.ts)
  const score = sumWeightsClamped(events, EVENT_WEIGHTS);

  // Upsert score record
  const scoreConditions = [eq(connectionScoresTable.candidateId, candidateId)];
  if (jobId) scoreConditions.push(eq(connectionScoresTable.jobId, jobId));
  const [existing] = await db
    .select()
    .from(connectionScoresTable)
    .where(and(...scoreConditions))
    .limit(1);

  if (existing) {
    await db
      .update(connectionScoresTable)
      .set({ score, lastCalculatedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectionScoresTable.id, existing.id));
  } else {
    await db.insert(connectionScoresTable).values({
      candidateId,
      jobId: jobId ?? undefined,
      employerId: employerId ?? undefined,
      score,
      lastCalculatedAt: new Date(),
    });
  }

  return score;
}

/** Get the most recent stored ConnectionStrengthScore for a candidate.
 *  When a jobId is provided but no job-scoped row exists, falls back to the
 *  candidate-level (no-jobId) score so the UI never shows a stale 0.
 */
export async function getConnectionScore(
  candidateId: string,
  jobId?: string,
): Promise<{ score: number; lastCalculatedAt: Date | null } | null> {
  const conditions = [eq(connectionScoresTable.candidateId, candidateId)];
  if (jobId) conditions.push(eq(connectionScoresTable.jobId, jobId));

  const [row] = await db
    .select()
    .from(connectionScoresTable)
    .where(and(...conditions))
    .limit(1);

  if (row) return { score: row.score, lastCalculatedAt: row.lastCalculatedAt };

  // Fallback: if no job-scoped row exists, return the candidate-level score
  if (jobId) {
    const [fallback] = await db
      .select()
      .from(connectionScoresTable)
      .where(eq(connectionScoresTable.candidateId, candidateId))
      .limit(1);
    if (fallback) return { score: fallback.score, lastCalculatedAt: fallback.lastCalculatedAt };
  }

  return null;
}

/** Derive top-3 contributing signals from raw events for display purposes. */
export function topSignals(events: { eventType: string }[]): string[] {
  // Employer-side counts ALL event types, including unweighted ones.
  return topSignalsByWeight(events, EVENT_WEIGHTS, { skipZeroWeight: false });
}
