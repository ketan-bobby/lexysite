/**
 * routes/communication.ts — Communication Events & Ghosting Risk
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Thin REST API over the communication_events and ghosting_risks tables.
 * Used by the candidate timeline UI to show a chronological feed of all
 * emails, in-app messages, and system events for a given candidate.
 * NOTE: "in-app messages" here are communication_events rows — there is NO
 * conversations/messages table pair (dead schema files deleted 2026-07; they
 * were never migrated, never imported, and never existed in any database).
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /communication/events   Fetch events for one or more candidates.
 *                                Accepts ?candidateId= (single) OR
 *                                ?candidateIds=a,b,c (comma-separated) so the
 *                                UI can merge sourced ID + normalized ID into
 *                                one timeline without two round trips.
 *   POST /communication/events   Insert a manual communication event (e.g. a
 *                                note a recruiter made after a phone call).
 *   GET  /communication/ghosting-risks  List ghosting risk rows for a candidate
 *                                       (used by the anti-ghost alert panel).
 *
 * ─── ID dual-lookup ──────────────────────────────────────────────────────────
 * Communication events may be recorded under the sourced_candidates.id (before
 * normalisation) OR the candidates.id (after normalisation). The API accepts
 * both IDs simultaneously so the frontend doesn't need to know which one was
 * used at record time.
 *
 * ─── Tenant isolation (Step-3 audit) ─────────────────────────────────────────
 * These endpoints expose per-candidate communication history and the full
 * candidate record on the ghosting panel. They MUST be sealed the same way
 * every other candidate-data surface is: authenticate the caller, scope every
 * read to the caller's tenant subtree (getAllowedTenantIds), and — for the
 * write path — validate the target candidateId belongs to the caller's scope
 * before recording an event. The candidate payload on ghosting-risks is run
 * through the shared mapCandidate allowlist so no privacy-posture column ever
 * rides along.
 */
import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import {
  communicationEventsTable, ghostingRisksTable, candidatesTable,
  sourcedCandidatesTable, usersTable,
} from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { validate } from "../middlewares/validate";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { mapCandidate } from "./candidates";

const CreateEventBody = z.object({
  candidateId: z.string().min(1),
  applicationId: z.string().optional().nullable(),
  type: z.string().min(1),
  channel: z.string().optional(),
  subject: z.string().optional().nullable(),
  body: z.string().optional().nullable(),
});

const router: IRouter = Router();

/* Resolve the authenticated caller. Writes 401 and returns null when the
   caller is anonymous or unknown. */
async function requireAuthedUser(req: Request, res: Response): Promise<any | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  return user;
}

/* Caller + the tenant ids they may READ candidate data for. Uses the same
   authoritative DATA-visibility ceiling every candidate/job surface uses
   (getDataScopeTenantIds): platform_admin ⇒ null (no filter); recruiter_admin
   ⇒ ONLY their assigned client sub-tenants (NOT the whole agency subtree, which
   getAllowedTenantIds would return — that is a compliance/staff ceiling, too
   broad for candidate data); everyone else ⇒ own tenant + subtree. This is what
   stops a recruiter_admin from reading another (unassigned) client's comms. */
async function getScope(
  req: Request, res: Response,
): Promise<{ user: any; allowed: string[] | null } | null> {
  const user = await requireAuthedUser(req, res);
  if (!user) return null;
  const allowed = await getDataScopeTenantIds(user);
  return { user, allowed };
}

/* Build an inArray tenant condition, or undefined (no filter) for
   platform_admin. An empty scope collapses to an impossible id so the query
   returns nothing rather than everything. */
function tenantCond(col: any, allowed: string[] | null) {
  if (allowed === null) return undefined;
  return inArray(col, allowed.length ? allowed : ["__none__"]);
}

/* Resolve a candidate id to the tenant that owns it, IF that tenant is inside
   the caller's scope. A comm event may be keyed by either candidates.id or
   sourced_candidates.id, so both tables are checked. Returns the owning
   tenantId, or null when the id is unknown / out of scope. */
async function resolveScopedCandidateTenant(
  id: string, allowed: string[] | null,
): Promise<string | null> {
  const [cand] = await db.select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable)
    .where(and(eq(candidatesTable.id, id), tenantCond(candidatesTable.tenantId, allowed)))
    .limit(1);
  if (cand) return cand.tenantId;
  const [sourced] = await db.select({ tenantId: sourcedCandidatesTable.tenantId })
    .from(sourcedCandidatesTable)
    .where(and(eq(sourcedCandidatesTable.id, id), tenantCond(sourcedCandidatesTable.tenantId, allowed)))
    .limit(1);
  return sourced ? sourced.tenantId : null;
}

router.get("/communication/events", async (req, res) => {
  const scope = await getScope(req, res); if (!scope) return;
  const { allowed } = scope;

  /* Accepts either a single ?candidateId= or a comma-separated ?candidateIds=
   * so the UI can fetch under both the sourced ID and the normalized
   * candidate ID — comm events may be recorded under either depending on
   * whether the candidate has been normalized into the candidates table. */
  const single = req.query.candidateId ? String(req.query.candidateId) : null;
  const multi = req.query.candidateIds ? String(req.query.candidateIds).split(",").map(s => s.trim()).filter(Boolean) : [];
  const ids = [...new Set<string>([...(single ? [single] : []), ...multi])];

  /* Tenant-scope every read (Step-3 audit): a caller only ever sees events
   * recorded within their own tenant subtree, regardless of which candidateId
   * they ask for. The candidateId filter is applied in SQL alongside it. */
  const events = await db.select().from(communicationEventsTable)
    .where(and(
      tenantCond(communicationEventsTable.tenantId, allowed),
      ids.length > 0 ? inArray(communicationEventsTable.candidateId, ids) : undefined,
    ))
    .orderBy(desc(communicationEventsTable.createdAt))
    .limit(MAX_PAGE_SIZE);

  res.json(events.map(e => ({ ...e, sentAt: e.sentAt?.toISOString() || null, createdAt: e.createdAt.toISOString() })));
});

router.post("/communication/events", validate({ body: CreateEventBody }), async (req, res) => {
  const scope = await getScope(req, res); if (!scope) return;
  const { allowed } = scope;
  const { candidateId, applicationId, type, channel, subject, body } = req.body;

  /* Ownership gate: the caller may only record an event against a candidate in
   * their own tenant scope. Resolving the owning tenant also fixes the old
   * hardcoded tenantId:"acme" stub — the event is stamped with the candidate's
   * real tenant so it reads back correctly through the tenant-scoped GET. */
  const ownerTenantId = await resolveScopedCandidateTenant(candidateId, allowed);
  if (!ownerTenantId) { res.status(404).json({ error: "Candidate not found" }); return; }

  const [event] = await db.insert(communicationEventsTable).values({
    tenantId: ownerTenantId,
    candidateId, applicationId, type, channel: channel || "email",
    subject, body,
    status: "sent",
    sentAt: new Date(),
  }).returning();
  res.json({ ...event, sentAt: event.sentAt?.toISOString() || null, createdAt: event.createdAt.toISOString() });
});

router.get("/communication/ghosting-risks", async (req, res) => {
  const scope = await getScope(req, res); if (!scope) return;
  const { allowed } = scope;

  // Defensive cap: see lib/query-limits.ts. Tenant-scoped (Step-3 audit).
  const risks = await db.select().from(ghostingRisksTable)
    .where(tenantCond(ghostingRisksTable.tenantId, allowed))
    .orderBy(desc(ghostingRisksTable.updatedAt))
    .limit(MAX_PAGE_SIZE);

  const withCandidates = await Promise.all(risks.map(async (risk) => {
    /* Only join a candidate that is inside the caller's scope; the record is
     * then run through the shared mapCandidate allowlist so no privacy-posture
     * column (discoveryPaused, blockedCompanyDomains, …) can ride along. */
    const [candidate] = await db.select().from(candidatesTable)
      .where(and(eq(candidatesTable.id, risk.candidateId), tenantCond(candidatesTable.tenantId, allowed)))
      .limit(1);
    return {
      candidateId: risk.candidateId,
      applicationId: risk.applicationId,
      riskLevel: risk.riskLevel,
      daysSinceLastContact: risk.daysSinceLastContact,
      lastContactType: risk.lastContactType,
      nextRequiredAction: risk.nextRequiredAction,
      candidate: candidate ? mapCandidate(candidate, 0) : null,
    };
  }));
  res.json(withCandidates);
});

export default router;
