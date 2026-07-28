/**
 * routes/candidate-events.ts — Candidate Event Log API
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /candidate-events                     Create a new event (system/integration use)
 *   GET  /candidates/:candidateId/events       Full timeline for a candidate (asc order)
 *   GET  /jobs/:jobId/events                   All events for a job (filters: type, date)
 *   GET  /jobs/:jobId/funnel                   Aggregated funnel counts + conversion %
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * All routes resolve the caller via bearer token and gate on getDataScopeTenantIds
 * (tenant subtree for admins, assigned clients for recruiter_admin). A PLAIN
 * recruiter is additionally ceilinged to assigned requisitions by enforceOwnership.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  candidateEventsTable, candidatesTable, jobsTable, usersTable,
  type CandidateEventType,
} from "@workspace/db";
import { eq, and, inArray, gte, lte, desc, asc } from "drizzle-orm";
import { controlDb } from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token.js";
import { getDataScopeTenantIds } from "../lib/tenantUtils.js";
import { validate } from "../middlewares/validate.js";
import { resolveUser } from "../middlewares/resolveUser.js";
import { enforceOwnership } from "../lib/ownership.js";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/* ── Auth helper ──────────────────────────────────────────────────────────── */
async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/* ── Tenant-gate a candidateId ─────────────────────────────────────────────── */
async function gatedCandidate(candidateId: string, user: any) {
  const [c] = await db.select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!c) return null;
  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(c.tenantId ?? "")) return null;
  }
  return c;
}

/* ── Tenant-gate a jobId ───────────────────────────────────────────────────── */
async function gatedJob(jobId: string, user: any) {
  const [j] = await db.select({ id: jobsTable.id, tenantId: jobsTable.tenantId })
    .from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!j) return null;
  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(j.tenantId ?? "")) return null;
  }
  return j;
}

/* ── POST /candidate-events ──────────────────────────────────────────────── */
const CreateEventBody = z.object({
  candidateId:   z.string().min(1),
  jobId:         z.string().min(1),
  tenantId:      z.string().min(1),
  applicationId: z.string().optional(),
  eventType:     z.string().min(1),
  actorType:     z.string().optional(),
  actorId:       z.string().optional(),
  source:        z.string().optional(),
  metadata:      z.record(z.unknown()).optional(),
});

router.post("/candidate-events", resolveUser, validate({ body: CreateEventBody }), enforceOwnership({ kinds: ["candidateId", "jobId"] }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const { candidateId, jobId, tenantId, applicationId, eventType, actorType, actorId, source, metadata } = req.body;

    if (user.role !== "platform_admin") {
      const allowed = await getDataScopeTenantIds(user);
      if (!allowed || !allowed.includes(tenantId)) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
    }

    await logCandidateEvent({
      candidateId, jobId, tenantId,
      applicationId: applicationId ?? null,
      eventType: eventType as CandidateEventType,
      actorType: actorType ?? actorTypeFromRole(user.role),
      actorId: actorId ?? user.id,
      source: source ?? "lexy_app",
      metadata,
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to create candidate event");
    res.status(500).json({ error: "Failed to create event" });
  }
});

/* ── GET /candidates/:candidateId/events ─────────────────────────────────── */
router.get("/candidates/:candidateId/events", resolveUser, enforceOwnership({ kinds: ["candidateId"] }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const cand = await gatedCandidate(req.params.candidateId, user);
    if (!cand) { res.status(404).json({ error: "Candidate not found" }); return; }

    /* classb-scope [guard-invisible]: a candidate's events carry a per-event tenant_id
       and may span tenants (cross-tenant applications). Gating the parent candidate
       does NOT scope these Class-B (no-RLS) child rows, so filter to the caller's own
       tenant subtree here. The inArray(...tenantId, allowed) push below is the sole
       tenant seal and check-classb-read.mjs can't see conds-array pushes — do NOT
       remove without re-scoping (baseline-allowlisted). platform_admin
       (getDataScopeTenantIds → null) sees all. */
    const conds: any[] = [eq(candidateEventsTable.candidateId, cand.id)];
    if (user.role !== "platform_admin") {
      const allowed = await getDataScopeTenantIds(user);
      conds.push(inArray(candidateEventsTable.tenantId, allowed && allowed.length ? allowed : ["__none__"]));
    }

    const events = await db.select().from(candidateEventsTable)
      .where(and(...conds))
      .orderBy(asc(candidateEventsTable.eventTimestamp));

    res.json(events.map(e => ({
      ...e,
      eventTimestamp: e.eventTimestamp?.toISOString() ?? null,
      createdAt: e.createdAt?.toISOString() ?? null,
    })));
  } catch (err) {
    logger.error({ err }, "Failed to get candidate events");
    res.status(500).json({ error: "Failed to get candidate events" });
  }
});

/* ── GET /jobs/:jobId/events ─────────────────────────────────────────────── */
router.get("/jobs/:jobId/events", resolveUser, enforceOwnership({ kinds: ["jobId"] }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const job = await gatedJob(req.params.jobId, user);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }

    const { eventType, from, to } = req.query as Record<string, string | undefined>;

    let conditions: any[] = [eq(candidateEventsTable.jobId, job.id)];
    if (eventType) conditions.push(eq(candidateEventsTable.eventType, eventType as CandidateEventType));
    if (from)      conditions.push(gte(candidateEventsTable.eventTimestamp, new Date(from)));
    if (to)        conditions.push(lte(candidateEventsTable.eventTimestamp, new Date(to)));

    const events = await db.select().from(candidateEventsTable)
      .where(and(...conditions))
      .orderBy(desc(candidateEventsTable.eventTimestamp))
      .limit(500);

    res.json(events.map(e => ({
      ...e,
      eventTimestamp: e.eventTimestamp?.toISOString() ?? null,
      createdAt: e.createdAt?.toISOString() ?? null,
    })));
  } catch (err) {
    logger.error({ err }, "Failed to get job events");
    res.status(500).json({ error: "Failed to get job events" });
  }
});

/* ── GET /jobs/:jobId/funnel ─────────────────────────────────────────────── */
const FUNNEL_STAGES: { eventType: CandidateEventType; label: string }[] = [
  { eventType: "INTERVIEW_INVITED",              label: "Interview Invited" },
  { eventType: "INTERVIEW_COMPLETED",            label: "Interview Completed" },
  { eventType: "RECRUITER_SHORTLISTED",          label: "Recruiter Shortlisted" },
  { eventType: "SUBMITTED_TO_HIRING_MANAGER",    label: "Submitted to HM" },
  { eventType: "HIRING_MANAGER_INTERVIEW_COMPLETED", label: "HM Interview Completed" },
  { eventType: "OFFER_EXTENDED",                 label: "Offer Extended" },
  { eventType: "OFFER_ACCEPTED",                 label: "Offer Accepted" },
  { eventType: "HIRED",                          label: "Hired" },
  { eventType: "STARTED",                        label: "Started" },
];

router.get("/jobs/:jobId/funnel", resolveUser, enforceOwnership({ kinds: ["jobId"] }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

    const job = await gatedJob(req.params.jobId, user);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }

    const allEvents = await db.select({
      eventType: candidateEventsTable.eventType,
      candidateId: candidateEventsTable.candidateId,
    })
      .from(candidateEventsTable)
      .where(eq(candidateEventsTable.jobId, job.id));

    /* Count unique candidates per event type (so a candidate invited twice
       still counts as 1 for INTERVIEW_INVITED). */
    const uniqueByType = new Map<string, Set<string>>();
    for (const e of allEvents) {
      if (!uniqueByType.has(e.eventType)) uniqueByType.set(e.eventType, new Set());
      uniqueByType.get(e.eventType)!.add(e.candidateId);
    }

    const stages = FUNNEL_STAGES.map((s, i) => {
      const count = uniqueByType.get(s.eventType)?.size ?? 0;
      const prevCount = i === 0
        ? count
        : (uniqueByType.get(FUNNEL_STAGES[i - 1].eventType)?.size ?? 0);
      const conversionPct = prevCount > 0 ? Math.round((count / prevCount) * 100) : null;
      return {
        eventType: s.eventType,
        label: s.label,
        count,
        conversionPct,
      };
    });

    res.json({ jobId: job.id, stages });
  } catch (err) {
    logger.error({ err }, "Failed to get job funnel");
    res.status(500).json({ error: "Failed to get job funnel" });
  }
});

export default router;
