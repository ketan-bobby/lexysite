/**
 * routes/outcomes.ts — Candidate Hiring Outcome Actions
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Provides recruiter action endpoints that advance a candidate through the
 * post-interview offer funnel and log immutable candidate events for each
 * transition. All writes are tenant-scoped and guarded.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /outcomes?applicationId=…       Get outcome record for an application
 *   PUT  /outcomes/:applicationId/extend-offer   → offer_extended  + OFFER_EXTENDED event
 *   PUT  /outcomes/:applicationId/accept-offer   → offer_accepted  + OFFER_ACCEPTED event
 *   PUT  /outcomes/:applicationId/decline-offer  → offer_declined  + OFFER_DECLINED event
 *   PUT  /outcomes/:applicationId/hire           → hired           + HIRED event
 *   PUT  /outcomes/:applicationId/start          → started         + STARTED event
 *   GET  /outcomes/:applicationId/events         List events for an application
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * All routes resolve the caller via bearer token and gate on getAllowedTenantIds.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  applicationsTable,
  candidateOutcomesTable,
  candidateEventsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { restrictToCompliantCandidates } from "../lib/compliance-scope.js";
import { controlDb } from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { validate } from "../middlewares/validate";
import { resolveUser } from "../middlewares/resolveUser";
import { logger } from "../lib/logger";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";
import { recordOutcome } from "../lib/intelligence.js";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";
import { PULSE_QUESTIONS } from "../lib/post-hire-pulse-scheduler.js";
import { createFeeLineItemIfEligible } from "../lib/fee-ledger.js";

const router: IRouter = Router();

/* ── Auth helper ──────────────────────────────────────────────────────────── */
async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/* ── Shared: resolve + tenant-gate an application ────────────────────────── */
async function getGatedApp(applicationId: string, user: any) {
  const [app] = await db.select().from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId)).limit(1);
  if (!app) return null;
  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(app.tenantId ?? "")) return null;
  }
  /* Plain-recruiter ownership ceiling: the application must belong to a
     requisition ASSIGNED to this recruiter, not merely to their tenant. Every
     outcome route funnels through getGatedApp, so this is the single choke
     point for the 2nd (post-tenant) gate. */
  if (user.role === "recruiter") {
    if (!app.jobId) return null;
    const assigned = await getRecruiterAssignedJobIds(user);
    if (!assigned.includes(app.jobId)) return null;
  }
  return app;
}

/* ── Upsert outcome row ───────────────────────────────────────────────────── */
async function upsertOutcome(patch: Partial<typeof candidateOutcomesTable.$inferInsert> & {
  tenantId: string; applicationId: string; candidateId: string; jobId: string;
}) {
  const [existing] = await db.select({ id: candidateOutcomesTable.id })
    .from(candidateOutcomesTable)
    .where(eq(candidateOutcomesTable.applicationId, patch.applicationId))
    .limit(1);

  if (existing) {
    const [updated] = await db.update(candidateOutcomesTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(candidateOutcomesTable.id, existing.id))
      .returning();
    return updated;
  }
  // Atomic insert; the unique index on application_id makes a concurrent insert
  // resolve to an UPDATE rather than a duplicate row (or a 23505 error).
  const { applicationId: _appId, ...conflictSet } = patch;
  const [inserted] = await db.insert(candidateOutcomesTable)
    .values({ id: crypto.randomUUID(), ...patch })
    .onConflictDoUpdate({
      target: candidateOutcomesTable.applicationId,
      set: { ...conflictSet, updatedAt: new Date() },
    })
    .returning();
  return inserted;
}

/* ── Log an immutable candidate event (delegates to shared logger) ─────────── */
async function logEvent(params: {
  candidateId: string;
  jobId: string;
  tenantId: string;
  applicationId?: string;
  eventType: "OFFER_EXTENDED" | "OFFER_ACCEPTED" | "OFFER_DECLINED" | "HIRED" | "STARTED";
  actorId?: string | null;
  actorType?: string;
  metadata?: Record<string, unknown>;
}) {
  await logCandidateEvent({
    candidateId:   params.candidateId,
    jobId:         params.jobId,
    tenantId:      params.tenantId,
    applicationId: params.applicationId ?? null,
    eventType:     params.eventType,
    actorType:     params.actorType ?? "recruiter",
    actorId:       params.actorId ?? null,
    source:        "lexy_app",
    metadata:      params.metadata,
  });
}

/* ── GET /outcomes ────────────────────────────────────────────────────────── */
router.get("/outcomes", resolveUser, async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { applicationId } = req.query;
    if (!applicationId) { res.status(400).json({ error: "applicationId required" }); return; }

    const app = await getGatedApp(applicationId as string, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    const [outcome] = await db.select().from(candidateOutcomesTable)
      .where(eq(candidateOutcomesTable.applicationId, applicationId as string))
      .limit(1);

    res.json(outcome ?? null);
  } catch (err) {
    logger.error({ err }, "Failed to get outcome");
    res.status(500).json({ error: "Failed to get outcome" });
  }
});

/* ── ExtendOfferBody ──────────────────────────────────────────────────────── */
const ExtendOfferBody = z.object({
  offerAmount: z.number().optional(),
  offerDate: z.string().optional(),
  outcomeSource: z.string().optional(),
});

/* ── PUT /outcomes/:applicationId/extend-offer ────────────────────────────── */
router.put("/outcomes/:applicationId/extend-offer", resolveUser, validate({ body: ExtendOfferBody }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    const allowedFrom = ["hm_review", "offer", "offer_recommended"];
    if (!allowedFrom.includes(app.stage)) {
      res.status(400).json({ error: `Cannot extend offer from stage '${app.stage}'. Must be in HM Review, Offer Recommended, or Offer.` });
      return;
    }

    const offerDate = req.body.offerDate ? new Date(req.body.offerDate) : new Date();

    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      to: "offer_extended",
      actor: { type: "user", role: user.role, id: user.id },
      source: "recruiter_action",
      applicationId: app.id,
    });

    const outcome = await upsertOutcome({
      tenantId: app.tenantId,
      applicationId: app.id,
      candidateId: app.candidateId,
      jobId: app.jobId,
      offerDate,
      offerAmount: req.body.offerAmount ?? undefined,
      outcomeSource: req.body.outcomeSource ?? "recruiter",
    });

    await logEvent({
      candidateId: app.candidateId,
      jobId: app.jobId,
      tenantId: app.tenantId,
      applicationId: app.id,
      eventType: "OFFER_EXTENDED",
      actorId: user.id,
      actorType: actorTypeFromRole(user.role),
      metadata: { offerAmount: req.body.offerAmount, offerDate: offerDate.toISOString() },
    });

    logger.info({ applicationId: app.id, candidateId: app.candidateId }, "Offer extended → stage: offer_extended");
    res.json({ ok: true, stage: "offer_extended", outcome });
  } catch (err) {
    logger.error({ err }, "Failed to extend offer");
    res.status(500).json({ error: "Failed to extend offer" });
  }
});

/* ── AcceptOfferBody ──────────────────────────────────────────────────────── */
const AcceptOfferBody = z.object({
  offerAcceptDate: z.string().optional(),
});

/* ── PUT /outcomes/:applicationId/accept-offer ────────────────────────────── */
router.put("/outcomes/:applicationId/accept-offer", resolveUser, validate({ body: AcceptOfferBody }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    if (app.stage !== "offer_extended") {
      res.status(400).json({ error: `Cannot accept offer from stage '${app.stage}'. Offer must be extended first.` });
      return;
    }

    const acceptDate = req.body.offerAcceptDate ? new Date(req.body.offerAcceptDate) : new Date();

    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      to: "offer_accepted",
      actor: { type: "user", role: user.role, id: user.id },
      source: "recruiter_action",
      applicationId: app.id,
    });

    const outcome = await upsertOutcome({
      tenantId: app.tenantId,
      applicationId: app.id,
      candidateId: app.candidateId,
      jobId: app.jobId,
      offerAccepted: true,
      offerAcceptDate: acceptDate,
    });

    await logEvent({
      candidateId: app.candidateId,
      jobId: app.jobId,
      tenantId: app.tenantId,
      applicationId: app.id,
      eventType: "OFFER_ACCEPTED",
      actorId: user.id,
      actorType: actorTypeFromRole(user.role),
      metadata: { offerAcceptDate: acceptDate.toISOString() },
    });

    /* Per-hire fee ledger: fire-and-forget — a fee-eligible L3XY-sourced hire
       (entry_type='sourced' + origin evidence) creates a pending_review line
       item for staff review. Never blocks or fails the accept flow. */
    void createFeeLineItemIfEligible({
      id: app.id,
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      entryType: (app as any).entryType,
      originEvidence: (app as any).originEvidence,
    });

    logger.info({ applicationId: app.id }, "Offer accepted → stage: offer_accepted");
    res.json({ ok: true, stage: "offer_accepted", outcome });
  } catch (err) {
    logger.error({ err }, "Failed to accept offer");
    res.status(500).json({ error: "Failed to accept offer" });
  }
});

/* ── DeclineOfferBody ─────────────────────────────────────────────────────── */
const DeclineOfferBody = z.object({
  declineReason: z.string().optional(),
});

/* ── PUT /outcomes/:applicationId/decline-offer ───────────────────────────── */
router.put("/outcomes/:applicationId/decline-offer", resolveUser, validate({ body: DeclineOfferBody }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    if (app.stage !== "offer_extended") {
      res.status(400).json({ error: `Cannot decline offer from stage '${app.stage}'. Offer must be extended first.` });
      return;
    }

    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      to: "offer_declined",
      actor: { type: "user", role: user.role, id: user.id },
      source: "recruiter_action",
      applicationId: app.id,
    });

    const outcome = await upsertOutcome({
      tenantId: app.tenantId,
      applicationId: app.id,
      candidateId: app.candidateId,
      jobId: app.jobId,
      offerAccepted: false,
      declineReason: req.body.declineReason ?? null,
    });

    await logEvent({
      candidateId: app.candidateId,
      jobId: app.jobId,
      tenantId: app.tenantId,
      applicationId: app.id,
      eventType: "OFFER_DECLINED",
      actorId: user.id,
      actorType: actorTypeFromRole(user.role),
      metadata: { declineReason: req.body.declineReason ?? null },
    });

    logger.info({ applicationId: app.id }, "Offer declined → stage: offer_declined");
    res.json({ ok: true, stage: "offer_declined", outcome });
  } catch (err) {
    logger.error({ err }, "Failed to decline offer");
    res.status(500).json({ error: "Failed to decline offer" });
  }
});

/* ── PUT /outcomes/:applicationId/hire ────────────────────────────────────── */
router.put("/outcomes/:applicationId/hire", resolveUser, validate({ body: z.object({ hireDate: z.string().optional() }) }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    const allowedFrom = ["offer_accepted", "offer", "offer_extended"];
    if (!allowedFrom.includes(app.stage)) {
      res.status(400).json({ error: `Cannot mark hired from stage '${app.stage}'. Offer must be accepted first.` });
      return;
    }

    const hireDate = req.body.hireDate ? new Date(req.body.hireDate) : new Date();

    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      to: "hired",
      actor: { type: "user", role: user.role, id: user.id },
      source: "recruiter_action",
      applicationId: app.id,
    });

    const outcome = await upsertOutcome({
      tenantId: app.tenantId,
      applicationId: app.id,
      candidateId: app.candidateId,
      jobId: app.jobId,
      hireDate,
      offerAccepted: true,
      outcome: "hired",
      outcomeAt: new Date(),
    });

    /* Mirror the terminal label onto the learning layer (best-effort, no-op when
     * no intelligence row exists for the pair). */
    recordOutcome(app.jobId, app.candidateId, "hired")
      .catch((err) => logger.warn({ err, applicationId: app.id }, "Failed to mirror hire outcome to intelligence (non-fatal)"));

    await logEvent({
      candidateId: app.candidateId,
      jobId: app.jobId,
      tenantId: app.tenantId,
      applicationId: app.id,
      eventType: "HIRED",
      actorId: user.id,
      actorType: actorTypeFromRole(user.role),
      metadata: { hireDate: hireDate.toISOString() },
    });

    logger.info({ applicationId: app.id }, "Candidate hired → stage: hired");
    res.json({ ok: true, stage: "hired", outcome });
  } catch (err) {
    logger.error({ err }, "Failed to mark hired");
    res.status(500).json({ error: "Failed to mark hired" });
  }
});

/* ── PUT /outcomes/:applicationId/start ───────────────────────────────────── */
router.put("/outcomes/:applicationId/start", resolveUser, validate({ body: z.object({ startDate: z.string().optional() }) }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    if (app.stage !== "hired") {
      res.status(400).json({ error: `Cannot mark started from stage '${app.stage}'. Candidate must be hired first.` });
      return;
    }

    const startDate = req.body.startDate ? new Date(req.body.startDate) : new Date();

    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      to: "started",
      actor: { type: "user", role: user.role, id: user.id },
      source: "recruiter_action",
      applicationId: app.id,
    });

    const outcome = await upsertOutcome({
      tenantId: app.tenantId,
      applicationId: app.id,
      candidateId: app.candidateId,
      jobId: app.jobId,
      startDate,
    });

    await logEvent({
      candidateId: app.candidateId,
      jobId: app.jobId,
      tenantId: app.tenantId,
      applicationId: app.id,
      eventType: "STARTED",
      actorId: user.id,
      actorType: actorTypeFromRole(user.role),
      metadata: { startDate: startDate.toISOString() },
    });

    logger.info({ applicationId: app.id }, "Candidate started → stage: started");
    res.json({ ok: true, stage: "started", outcome });
  } catch (err) {
    logger.error({ err }, "Failed to mark started");
    res.status(500).json({ error: "Failed to mark started" });
  }
});

/* ── Quality-of-hire pulse ────────────────────────────────────────────────── */
/* Compute a 0–100 hire-quality score from all collected 1–5 ratings. */
function computeQualityScore(pulseResponses: Record<string, any> | null | undefined): number | null {
  if (!pulseResponses) return null;
  const ratings: number[] = [];
  for (const phase of Object.keys(pulseResponses)) {
    const arr = (pulseResponses[phase]?.ratings ?? []) as unknown[];
    for (const r of arr) {
      const n = Number(r);
      if (Number.isFinite(n) && n >= 1 && n <= 5) ratings.push(n);
    }
  }
  if (ratings.length === 0) return null;
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  // Map a 1–5 mean onto 0–100.
  return Math.round(((mean - 1) / 4) * 100);
}

/* Quality-of-hire feedback is a STAFF signal — only hiring managers, recruiters
 * and admins may read or submit a pulse. Candidate accounts (who share the same
 * tenant and would otherwise pass getGatedApp) must never write a quality label
 * about their own hire — that would poison the learning loop. */
const PULSE_ROLES = new Set(["hiring_manager", "recruiter", "tenant_admin", "platform_admin"]);

/* ── GET /outcomes/:applicationId/pulse ───────────────────────────────────── */
/* Load the questions + current pulse state for the in-app hiring-manager form. */
router.get("/outcomes/:applicationId/pulse", resolveUser, async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!PULSE_ROLES.has(user.role)) { res.status(403).json({ error: "Forbidden" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    const [outcome] = await db.select().from(candidateOutcomesTable)
      .where(eq(candidateOutcomesTable.applicationId, req.params.applicationId)).limit(1);
    if (!outcome) { res.status(404).json({ error: "No outcome record for this application" }); return; }

    res.json({
      questions: PULSE_QUESTIONS,
      outcome: {
        applicationId: outcome.applicationId,
        hireDate: outcome.hireDate,
        hireQualityScore: outcome.hireQualityScore,
        pulse30RespondedAt: outcome.pulse30RespondedAt,
        pulse90RespondedAt: outcome.pulse90RespondedAt,
        pulseResponses: outcome.pulseResponses ?? null,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to load pulse");
    res.status(500).json({ error: "Failed to load pulse" });
  }
});

/* ── PUT /outcomes/:applicationId/pulse ───────────────────────────────────── */
/* Hiring manager submits the 30/90-day pulse. Persists answers, stamps the
 * phase response time, and (re)computes the hire_quality_score. */
const PulseBody = z.object({
  phase: z.enum(["30", "90"]),
  ratings: z.array(z.number().min(1).max(5)).min(1).max(10),
  comment: z.string().max(2000).optional(),
});

router.put("/outcomes/:applicationId/pulse", resolveUser, validate({ body: PulseBody }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!PULSE_ROLES.has(user.role)) { res.status(403).json({ error: "Forbidden" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    const [outcome] = await db.select().from(candidateOutcomesTable)
      .where(eq(candidateOutcomesTable.applicationId, req.params.applicationId)).limit(1);
    if (!outcome) { res.status(404).json({ error: "No outcome record for this application" }); return; }
    if (outcome.outcome !== "hired") { res.status(400).json({ error: "Pulse is only available for hired candidates." }); return; }

    const phase = req.body.phase as "30" | "90";
    const now = new Date();
    const existingResponses = (outcome.pulseResponses ?? {}) as Record<string, any>;
    const merged = {
      ...existingResponses,
      [phase]: {
        ratings: req.body.ratings,
        comment: req.body.comment ?? null,
        respondedAt: now.toISOString(),
        respondedByUserId: user.id,
      },
    };
    const hireQualityScore = computeQualityScore(merged);

    const [updated] = await db.update(candidateOutcomesTable)
      .set({
        pulseResponses: merged,
        hireQualityScore,
        ...(phase === "30" ? { pulse30RespondedAt: now } : { pulse90RespondedAt: now }),
        updatedAt: now,
      })
      .where(eq(candidateOutcomesTable.id, outcome.id))
      .returning();

    logger.info({ applicationId: req.params.applicationId, phase, hireQualityScore }, "Hire-quality pulse recorded");
    res.json({ ok: true, hireQualityScore, outcome: updated });
  } catch (err) {
    logger.error({ err }, "Failed to record pulse");
    res.status(500).json({ error: "Failed to record pulse" });
  }
});

/* ── GET /outcomes/coverage ───────────────────────────────────────────────── */
/* Label-coverage indicator: how many hires have post-hire quality data, plus a
 * terminal-outcome breakdown so admins can see label completeness. Tenant-scoped. */
router.get("/outcomes/coverage", resolveUser, async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    let tenantPredicate;
    if (user.role !== "platform_admin") {
      const allowed = await getDataScopeTenantIds(user);
      if (!allowed || allowed.length === 0) { res.json(emptyCoverage()); return; }
      tenantPredicate = inArray(candidateOutcomesTable.tenantId, allowed);
    }
    /* A plain recruiter's coverage counts only their assigned requisitions. */
    if (user.role === "recruiter") {
      const assigned = await getRecruiterAssignedJobIds(user);
      if (assigned.length === 0) { res.json(emptyCoverage()); return; }
      const recruiterPredicate = inArray(candidateOutcomesTable.jobId, assigned);
      tenantPredicate = tenantPredicate ? and(tenantPredicate, recruiterPredicate) : recruiterPredicate;
    }

    /* Compliance: exclude GDPR-erased / do-not-contact candidates from every
       outcome count (candidate_outcomes = terminal-enum axis). */
    const compliancePred = restrictToCompliantCandidates(candidateOutcomesTable.candidateId);
    const whereClause = tenantPredicate ? and(tenantPredicate, compliancePred) : compliancePred;

    const [row] = await db.select({
      hires:            sql<number>`count(*) filter (where ${candidateOutcomesTable.outcome} = 'hired')`,
      hiresWithQuality: sql<number>`count(*) filter (where ${candidateOutcomesTable.outcome} = 'hired' and ${candidateOutcomesTable.hireQualityScore} is not null)`,
      pulse30Sent:      sql<number>`count(*) filter (where ${candidateOutcomesTable.pulse30SentAt} is not null)`,
      pulse30Responded: sql<number>`count(*) filter (where ${candidateOutcomesTable.pulse30RespondedAt} is not null)`,
      pulse90Sent:      sql<number>`count(*) filter (where ${candidateOutcomesTable.pulse90SentAt} is not null)`,
      pulse90Responded: sql<number>`count(*) filter (where ${candidateOutcomesTable.pulse90RespondedAt} is not null)`,
      rejected:         sql<number>`count(*) filter (where ${candidateOutcomesTable.outcome} = 'rejected')`,
      withdrawn:        sql<number>`count(*) filter (where ${candidateOutcomesTable.outcome} = 'withdrawn')`,
      ghosted:          sql<number>`count(*) filter (where ${candidateOutcomesTable.outcome} = 'ghosted')`,
      avgQuality:       sql<number | null>`avg(${candidateOutcomesTable.hireQualityScore}) filter (where ${candidateOutcomesTable.hireQualityScore} is not null)`,
    })
      .from(candidateOutcomesTable)
      .where(whereClause);

    const hires = Number(row?.hires ?? 0);
    const hiresWithQuality = Number(row?.hiresWithQuality ?? 0);
    res.json({
      hires,
      hiresWithQuality,
      qualityCoveragePct: hires > 0 ? Math.round((hiresWithQuality / hires) * 100) : 0,
      avgHireQualityScore: row?.avgQuality != null ? Math.round(Number(row.avgQuality)) : null,
      pulse30Sent: Number(row?.pulse30Sent ?? 0),
      pulse30Responded: Number(row?.pulse30Responded ?? 0),
      pulse90Sent: Number(row?.pulse90Sent ?? 0),
      pulse90Responded: Number(row?.pulse90Responded ?? 0),
      outcomes: {
        hired: hires,
        rejected: Number(row?.rejected ?? 0),
        withdrawn: Number(row?.withdrawn ?? 0),
        ghosted: Number(row?.ghosted ?? 0),
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to compute outcome coverage");
    res.status(500).json({ error: "Failed to compute outcome coverage" });
  }
});

function emptyCoverage() {
  return {
    hires: 0, hiresWithQuality: 0, qualityCoveragePct: 0, avgHireQualityScore: null,
    pulse30Sent: 0, pulse30Responded: 0, pulse90Sent: 0, pulse90Responded: 0,
    outcomes: { hired: 0, rejected: 0, withdrawn: 0, ghosted: 0 },
  };
}

/* ── GET /outcomes/:applicationId/events ─────────────────────────────────── */
router.get("/outcomes/:applicationId/events", resolveUser, async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const app = await getGatedApp(req.params.applicationId, user);
    if (!app) { res.status(404).json({ error: "Not found" }); return; }

    const events = await db.select().from(candidateEventsTable)
      .where(and(
        eq(candidateEventsTable.candidateId, app.candidateId),
        eq(candidateEventsTable.jobId, app.jobId),
      ))
      .orderBy(candidateEventsTable.eventTimestamp);

    res.json(events);
  } catch (err) {
    logger.error({ err }, "Failed to list events");
    res.status(500).json({ error: "Failed to list events" });
  }
});

export default router;
