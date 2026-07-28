/**
 * routes/connection-engine.ts — Recruiter-Side Connection Score API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Exposes the employer-side Connection Engine: scoring how "connected" a
 * recruiter or tenant is to a given candidate based on shared signals
 * (views, messages, referrals, platform interactions). Used by the recruiter
 * dashboard to surface warm leads and prioritise outreach.
 *
 * Additive module — does NOT modify any existing routes. All endpoints live
 * under /api/connection-*.
 *
 * Feature flag: set ENABLE_CONNECTION_ENGINE=true to activate.
 * If the flag is absent or false, all endpoints return 404.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /connection-score/:candidateId   Stored score + label + top signals
 *   GET  /connection-events/:candidateId  Full event history for a candidate
 *   POST /connection-event                Record a new connection event
 *                                         (view, message_sent, referral, etc.)
 *   POST /connection-score/:candidateId/recalculate
 *     Force-recalculate a candidate's connection score from their event history.
 *
 * ─── Score shape ─────────────────────────────────────────────────────────────
 *   score   — 0–100 composite score
 *   label   — "cold" | "warm" | "hot" | "engaged"
 *   signals — top contributing event types with their weights
 */

import { Router, type IRouter } from "express";
import { resolveUser } from "../middlewares/resolveUser";
import { z } from "zod";
import { db } from "@workspace/db";
import { connectionEventsTable, candidatesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  getConnectionScore,
  getConnectionEvents,
  recalculateConnectionScore,
  topSignals,
} from "../lib/connectionEngine";
import { logger } from "../lib/logger";
import { validate } from "../middlewares/validate";

const ConnectionEventBody = z.object({
  candidateId: z.string().min(1),
  eventType: z.string().min(1),
  jobId: z.string().optional(),
  employerId: z.string().optional(),
  eventValue: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

const ConnectionScoreRecalcBody = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().optional(),
  employerId: z.string().optional(),
}).passthrough();

const router: IRouter = Router();

// ─── Feature-flag guard ───────────────────────────────────────────────────────
function isEnabled(): boolean {
  return process.env.ENABLE_CONNECTION_ENGINE === "true";
}

function featureGuard(req: any, res: any, next: any) {
  if (!isEnabled()) {
    return res.status(404).json({ error: "Connection Engine is not enabled." });
  }
  next();
}

/* Auth note (2026-05-18 audit fix): the connection-engine routes were
 * mounted unprefixed at the application root, with only `featureGuard`
 * applied per path. Any unauthenticated caller could read a candidate's
 * connection score or POST events for any candidate. We now apply
 * `resolveUser` to the same exact path prefixes as `featureGuard` so the
 * middleware is properly scoped to this router's routes only and does not
 * swallow sibling routes mounted after it (the outreach.ts bug pattern). */
/* Tenant scoping: these routes take a caller-supplied candidateId (in the URL
 * params for the GETs, in the body for the POSTs) but the connection_events /
 * connection_scores tables have NO tenant_id column and are NOT RLS-protected,
 * so nothing else stops a caller from reading/writing another tenant's
 * candidate's connection data. We gate on the RLS-protected candidates table
 * instead: the `db` proxy is bound to the caller's allowed tenant subtree by
 * withTenantContext, so a candidate row is visible here ONLY if the candidate
 * belongs to the caller's tenant. No visible row → 404 (never leak existence). */
async function scopeCandidate(req: any, res: any, next: any) {
  const candidateId: string | undefined = req.params?.candidateId ?? req.body?.candidateId;
  if (!candidateId) return next(); // let the handler return its own 400
  try {
    const [row] = await db
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);
    if (!row) return res.status(404).json({ error: "Candidate not found" });
    return next();
  } catch (err) {
    logger.error(err, "connection-engine candidate scope check failed");
    return res.status(500).json({ error: "Failed to authorize request." });
  }
}

router.use("/connection-score", featureGuard, resolveUser, scopeCandidate);
router.use("/connection-events", featureGuard, resolveUser, scopeCandidate);
router.use("/connection-event", featureGuard, resolveUser, scopeCandidate);

// ─── GET /api/connection-score/:candidateId ───────────────────────────────────
// Returns the stored score + label + top signals for a candidate.
router.get("/connection-score/:candidateId", async (req, res) => {
  const { candidateId } = req.params;
  const jobId = req.query.jobId as string | undefined;

  try {
    const scoreRow = await getConnectionScore(candidateId, jobId);
    const events = await getConnectionEvents(candidateId, jobId);
    const signals = topSignals(events);

    const score = scoreRow?.score ?? 0;

    res.json({
      candidateId,
      jobId: jobId ?? null,
      score,
      label: scoreLabel(score),
      topSignals: signals,
      lastCalculatedAt: scoreRow?.lastCalculatedAt ?? null,
    });
  } catch (err) {
    logger.error(err, "connection-score GET error");
    res.status(500).json({ error: "Failed to fetch connection score." });
  }
});

// ─── GET /api/connection-events/:candidateId ──────────────────────────────────
// Returns all connection events for a candidate.
router.get("/connection-events/:candidateId", async (req, res) => {
  const { candidateId } = req.params;
  const jobId = req.query.jobId as string | undefined;

  try {
    const events = await getConnectionEvents(candidateId, jobId);
    res.json({ candidateId, jobId: jobId ?? null, events });
  } catch (err) {
    logger.error(err, "connection-events GET error");
    res.status(500).json({ error: "Failed to fetch connection events." });
  }
});

// ─── POST /api/connection-event ───────────────────────────────────────────────
// Records a new connection event and recalculates the score.
// Body: { candidateId, eventType, jobId?, employerId?, eventValue?, metadata? }
router.post("/connection-event", validate({ body: ConnectionEventBody }), async (req, res) => {
  const { candidateId, eventType, jobId, employerId, eventValue, metadata } = req.body;

  if (!candidateId || !eventType) {
    return res.status(400).json({ error: "candidateId and eventType are required." });
  }

  const VALID_EVENT_TYPES = [
    "replied_to_outreach",
    "response_within_24h",
    "accepted_intro",
    "booked_interview",
    "completed_interview",
    "viewed_opportunity",
    "multiple_interactions",
    "no_show",
    "declined_role",
  ];

  if (!VALID_EVENT_TYPES.includes(eventType)) {
    return res.status(400).json({
      error: `Unknown eventType. Valid types: ${VALID_EVENT_TYPES.join(", ")}`,
    });
  }

  try {
    const [event] = await db
      .insert(connectionEventsTable)
      .values({ candidateId, eventType, jobId, employerId, eventValue, metadata })
      .returning();

    const newScore = await recalculateConnectionScore(candidateId, jobId, employerId);

    res.status(201).json({
      event,
      newScore,
      label: scoreLabel(newScore),
    });
  } catch (err) {
    logger.error(err, "connection-event POST error");
    res.status(500).json({ error: "Failed to create connection event." });
  }
});

// ─── POST /api/connection-score/recalculate ───────────────────────────────────
// Manually triggers score recalculation for a candidate.
// Body: { candidateId, jobId?, employerId? }
router.post("/connection-score/recalculate", validate({ body: ConnectionScoreRecalcBody }), async (req, res) => {
  const { candidateId, jobId, employerId } = req.body;

  if (!candidateId) {
    return res.status(400).json({ error: "candidateId is required." });
  }

  try {
    const score = await recalculateConnectionScore(candidateId, jobId, employerId);
    res.json({ candidateId, jobId: jobId ?? null, score, label: scoreLabel(score) });
  } catch (err) {
    logger.error(err, "connection-score recalculate error");
    res.status(500).json({ error: "Failed to recalculate connection score." });
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function scoreLabel(score: number): string {
  if (score <= 30) return "Cold";
  if (score <= 60) return "Warming";
  if (score <= 80) return "Engaged";
  return "High Intent";
}

export default router;
