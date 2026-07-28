/**
 * routes/candidate-connection-engine.ts — Candidate-Side Connection Insights API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Exposes the candidate-side view of the Connection Engine: tracking which
 * companies have viewed a candidate's profile, which recruiters have messaged
 * them, and producing an "interest score" that the candidate can see in their
 * portal. Completely isolated from the employer-side routes in connection-engine.ts.
 *
 * Candidate-side only. All routes live under /api/candidate/connection-*.
 *
 * Feature flag: ENABLE_CANDIDATE_CONNECTION_ENGINE=true
 * If absent or false → all endpoints return 404, existing app is unchanged.
 *
 * Auth pattern: canonical portal-auth resolveCandidateId (HMAC-verified session
 * sub → users row → candidates.user_id FK; role must be "candidate"). Candidate
 * self-only — no recruiter/admin access, no email-join, no silent id fallback.
 *
 * DOES NOT modify employer-side routes, scoring, or ranking.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /candidate/connection-insights         All insight summaries for the
 *                                               authenticated candidate
 *   GET  /candidate/connection-insights/:jobId  Insight for one specific job
 *   POST /candidate/connection-event            Record a candidate-side event
 *                                               (profile_view, portal_login,
 *                                               document_download, etc.)
 *   POST /candidate/connection-insights/recalculate  Force-recalculate insights
 *
 * ─── Insight shape ───────────────────────────────────────────────────────────
 *   companyInterestScore  — 0–100 inferred interest level from employer actions
 *   recruiterEngagements  — count of distinct recruiter touch-points
 *   lastSignalAt          — timestamp of the most recent signal
 *   topSignals            — top event types that drove the score
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { validate } from "../middlewares/validate";
import { logger } from "../lib/logger";
import {
  recordCandidateConnectionEvent,
  recalculateCandidateInsights,
  getCandidateConnectionInsights,
  getCandidateConnectionInsight,
  VALID_CANDIDATE_EVENT_TYPES,
  CANDIDATE_EVENT_LABELS,
} from "../lib/candidateConnectionEngine";
import { resolveCandidateId } from "../lib/portal-auth";

const CandidateConnectionEventBody = z.object({
  eventType: z.string().min(1),
  jobId: z.string().optional(),
  employerId: z.string().optional(),
  eventValue: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
  context: z.unknown().optional(),
}).passthrough();

const CandidateConnectionRecalcBody = z.object({
  jobId: z.string().optional(),
  employerId: z.string().optional(),
  context: z.unknown().optional(),
}).passthrough();

const router: IRouter = Router();

// ─── Feature-flag guard ───────────────────────────────────────────────────────
function isEnabled(): boolean {
  return process.env.ENABLE_CANDIDATE_CONNECTION_ENGINE === "true";
}

function featureGuard(req: any, res: any, next: any) {
  if (!isEnabled()) {
    return res.status(404).json({ error: "Candidate Connection Engine is not enabled." });
  }
  next();
}

router.use("/candidate/connection-event", featureGuard);
router.use("/candidate/connection-insights", featureGuard);
router.use("/candidate/connection-insight", featureGuard);

// ─── Auth helper ─────────────────────────────────────────────────────────────
// The candidate-side connection engine is portal-only: every route below acts on
// the AUTHENTICATED candidate's own record. We use the canonical portal-auth
// resolveCandidateId (HMAC-verified session `sub` → users row → candidates.user_id
// FK, role must be "candidate") — the SAME resolver the ~30 other portal reads use.
//
// This deliberately REMOVES the three latent auth-shadow properties the previous
// local resolver carried: (1) accepting role === "recruiter" (a recruiter on a
// candidate /me route is never intended), (2) resolving the candidate via an
// email-join (identity comes from the signed session, not a correlatable field),
// and (3) the `?? u.id` silent fallback (a resolver must never return a different
// id when it cannot resolve the intended one). resolveCandidateId returns null on
// any failure → caller responds 401.

// ─── POST /api/candidate/connection-event ─────────────────────────────────────
// Records a new engagement signal for the authenticated candidate.
// Body: { eventType, jobId?, employerId?, eventValue?, metadata?, context? }
router.post("/candidate/connection-event", validate({ body: CandidateConnectionEventBody }), async (req, res) => {
  const candidateId = await resolveCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

  const { eventType, jobId, employerId, eventValue, metadata, context } = req.body;

  if (!eventType) {
    return res.status(400).json({ error: "eventType is required." });
  }
  if (!VALID_CANDIDATE_EVENT_TYPES.includes(eventType)) {
    return res.status(400).json({
      error: `Unknown eventType. Valid types: ${VALID_CANDIDATE_EVENT_TYPES.join(", ")}`,
    });
  }

  try {
    const event = await recordCandidateConnectionEvent({
      candidateId,
      eventType,
      jobId,
      employerId,
      eventValue,
      metadata,
    });

    // Immediately recalculate the insight after the new event
    const insight = await recalculateCandidateInsights(candidateId, jobId, employerId, context);

    return res.status(201).json({ event, insight });
  } catch (err) {
    logger.error(err, "candidate/connection-event POST error");
    return res.status(500).json({ error: "Failed to record connection event." });
  }
});

// ─── GET /api/candidate/connection-insights/me ────────────────────────────────
// Convenience: returns all insights for the currently authenticated candidate.
// MUST be registered BEFORE the "/:candidateId" route below — Express matches in
// definition order, so if "/:candidateId" came first it would capture "me" as the
// param (authId !== "me" → 404) and this route would be dead. (static-before-param)
router.get("/candidate/connection-insights/me", async (req, res) => {
  const candidateId = await resolveCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const insights = await getCandidateConnectionInsights(candidateId);
    return res.json({ candidateId, insights, eventLabels: CANDIDATE_EVENT_LABELS });
  } catch (err) {
    logger.error(err, "candidate/connection-insights/me GET error");
    return res.status(500).json({ error: "Failed to fetch insights." });
  }
});

// ─── GET /api/candidate/connection-insights/:candidateId ──────────────────────
// Returns all stored insights for a candidate (across all jobs).
// Candidate self-only: the authId from the session must equal the :candidateId in
// the path (belt-and-suspenders on top of the candidate-only resolver), else 404.
router.get("/candidate/connection-insights/:candidateId", async (req, res) => {
  const { candidateId } = req.params;

  // Self-only: the resolved auth identity must match the candidate in the
  // URL. Previously this only checked that *some* candidate auth existed,
  // letting any logged-in candidate read another candidate's insights by
  // changing the path param (IDOR, 2026-05-18 audit fix).
  const authId = await resolveCandidateId(req);
  if (!authId) return res.status(401).json({ error: "Unauthorized" });
  if (authId !== candidateId) return res.status(404).json({ error: "Not found" });

  try {
    const insights = await getCandidateConnectionInsights(candidateId);
    return res.json({ candidateId, insights });
  } catch (err) {
    logger.error(err, "candidate/connection-insights GET error");
    return res.status(500).json({ error: "Failed to fetch insights." });
  }
});

// ─── GET /api/candidate/connection-insight/:candidateId/:jobId ────────────────
// Returns the insight for one candidate + job pair.
router.get("/candidate/connection-insight/:candidateId/:jobId", async (req, res) => {
  const { candidateId, jobId } = req.params;

  // Self-only: see /candidate/connection-insights/:candidateId for context
  // (2026-05-18 audit fix — was a cross-candidate read by URL).
  const authId = await resolveCandidateId(req);
  if (!authId) return res.status(401).json({ error: "Unauthorized" });
  if (authId !== candidateId) return res.status(404).json({ error: "Not found" });

  try {
    const insight = await getCandidateConnectionInsight(candidateId, jobId);
    if (!insight) {
      // Return a zero-state insight rather than 404 — the UI can display
      // a "no data yet" state rather than an error.
      return res.json({
        candidateId,
        jobId,
        connectionStrengthScore: 0,
        connectionStrengthLabel: "Cold",
        hiringMomentumScore: null,
        hiringMomentumLabel: null,
        nextBestAction: "Start engaging with this opportunity to build your momentum.",
        topSignals: [],
        lastCalculatedAt: null,
      });
    }
    return res.json(insight);
  } catch (err) {
    logger.error(err, "candidate/connection-insight GET error");
    return res.status(500).json({ error: "Failed to fetch insight." });
  }
});

// ─── POST /api/candidate/connection-insights/recalculate ─────────────────────
// Manually recalculates insights for the authenticated candidate.
// Body: { jobId?, employerId?, context? }
router.post("/candidate/connection-insights/recalculate", validate({ body: CandidateConnectionRecalcBody }), async (req, res) => {
  const candidateId = await resolveCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

  const { jobId, employerId, context } = req.body;

  try {
    const insight = await recalculateCandidateInsights(candidateId, jobId, employerId, context);
    return res.json({ candidateId, jobId: jobId ?? null, ...insight });
  } catch (err) {
    logger.error(err, "candidate/connection-insights/recalculate POST error");
    return res.status(500).json({ error: "Failed to recalculate insights." });
  }
});

export default router;
