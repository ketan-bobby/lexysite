/**
 * ownership.ts — the single recruiter OWNERSHIP-enforcement middleware.
 *
 * WHAT THIS IS
 * ------------
 * A plain `recruiter` may only touch records tied to requisitions ASSIGNED to
 * them (jobs.assigned_recruiter_id OR the job_recruiters join table — see
 * getRecruiterAssignedJobIds). This middleware enforces that ceiling as a SECOND
 * gate that runs AFTER the existing tenant-scope guards in each route.
 *
 * DESIGN RULES (approved matrix)
 * ------------------------------
 *   1. It ADDS a layer. It never replaces or weakens an existing tenant/authz
 *      guard — those stay in the route exactly as they are. This middleware only
 *      answers the recruiter-assignment question.
 *   2. Admin roles (platform_admin, tenant_admin, recruiter_admin, hiring_manager,
 *      interviewer, candidate self-paths) BYPASS the recruiter ceiling here. Their
 *      tenant / data-scope ceiling is enforced elsewhere (getDataScopeTenantIds
 *      swaps + route tenant guards) and is unaffected by this file.
 *   3. Fail-closed: a plain recruiter with no assigned reqs owns nothing.
 *   4. Non-owned OR non-existent resource ⇒ 404 (never 403) so we don't confirm
 *      the existence of a resource the recruiter isn't allowed to see.
 *   5. Missing / malformed id in the request ⇒ 400 (client error — the request
 *      itself is not well-formed for an ownership-gated route).
 *   6. Efficient: the recruiter's assigned-req id set is resolved ONCE per request
 *      and cached on the request object; multiple resources on one request reuse it.
 *
 * OPT-OUT
 * -------
 * A route that legitimately carries no ownable id, or is intentionally agency-wide
 * (e.g. talent rediscovery reads), opts out with exemptFromOwnership(route, JUST)
 * where JUST is a NAMED constant from OWNERSHIP_EXEMPTION — no anonymous exemptions.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  controlDb,
  usersTable,
  applicationsTable,
  outreachCampaignsTable,
  sourcedCandidatesTable,
  talentPoolSubmissionsTable,
} from "@workspace/db";
import { getRecruiterAssignedJobIds } from "./tenantUtils";
import { getAuthUserId } from "./auth-token";
import { logger } from "./logger";

/** The minimal caller shape the ownership ceiling needs. */
interface OwnershipCaller {
  id: string;
  role: string;
  tenantId: string | null;
}

/**
 * Resolve the caller for the ownership check. Routes in this codebase populate
 * the caller two different ways: some run resolveUser (⇒ req.resolvedUser),
 * others resolve it in-handler via getAuthUserId + a users lookup. So this
 * middleware works as a single drop-in on BOTH styles: it prefers an existing
 * req.resolvedUser, and otherwise resolves the caller itself from the bearer
 * token and caches it back on req.resolvedUser for the downstream handler.
 *
 * This is purely a *lookup* convenience — it adds no authority. A caller with no
 * valid token resolves to null (⇒ 401), and role/tenant come straight from the
 * users row, exactly as the in-handler helpers derive them.
 */
async function resolveCaller(req: Request): Promise<OwnershipCaller | null> {
  const existing = (req as any).resolvedUser as OwnershipCaller | undefined;
  if (existing?.id) return existing;
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [user] = await controlDb
    .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) return null;
  const caller: OwnershipCaller = { id: user.id, role: user.role, tenantId: user.tenantId };
  (req as any).resolvedUser = (req as any).resolvedUser ?? caller;
  return caller;
}

/* The resource kinds this middleware can resolve to an owning requisition. */
export type OwnershipIdKind = "jobId" | "candidateId" | "applicationId" | "campaignId";

/* Canonical param / body key for each kind (the names actually used across the
 * audited routes). `:id` is deliberately NOT canonical — it is ambiguous
 * (campaign vs message vs enrollment), so routes that use `:id` must declare the
 * kind explicitly via paramAliases. */
const CANONICAL_KEYS: Record<OwnershipIdKind, string> = {
  jobId: "jobId",
  candidateId: "candidateId",
  applicationId: "applicationId",
  campaignId: "campaignId",
};

export interface EnforceOwnershipOptions {
  /** Restrict which kinds to look for. Default: all four canonical kinds. */
  kinds?: OwnershipIdKind[];
  /** Extra route-param names that map to a kind, e.g. { campaignId: ["id"] }. */
  paramAliases?: Partial<Record<OwnershipIdKind, string[]>>;
  /** Extra body keys that map to a kind. */
  bodyAliases?: Partial<Record<OwnershipIdKind, string[]>>;
  /**
   * When true (default) a request that carries NO recognised id is a 400. Set
   * false for routes where the id is genuinely optional (e.g. parse-cvs jobId):
   * absence ⇒ pass-through, presence ⇒ still enforced.
   */
  requireId?: boolean;
}

/* ─────────────────────────────── Exemptions ─────────────────────────────── */

/** Named justifications for opting a route OUT of ownership enforcement. Every
 *  exemption MUST reference one of these — this keeps opt-outs greppable and
 *  reviewable (no anonymous exemptions). */
export const OWNERSHIP_EXEMPTION = {
  CANDIDATE_SELF_PATH:
    "candidate self-path: gated by interview capability-token cookie or authId↔candidateId, not recruiter ownership",
  TALENT_REDISCOVERY_READ:
    "read-only talent rediscovery: agency-wide candidate discovery is intentional; writes still require requisition assignment",
  NO_OWNABLE_RESOURCE:
    "route carries no candidate/job/application/campaign id to own (e.g. list/create scoped by tenant only)",
  ADMIN_ONLY_ROUTE:
    "route is already restricted to admin-class roles that bypass the recruiter ceiling by design",
} as const;

export type OwnershipExemption =
  (typeof OWNERSHIP_EXEMPTION)[keyof typeof OWNERSHIP_EXEMPTION];

interface ExemptionRecord {
  route: string;
  justification: OwnershipExemption;
}
const exemptionRegistry: ExemptionRecord[] = [];

/**
 * exemptFromOwnership(route, JUSTIFICATION_CONSTANT) — a pass-through middleware
 * that documents (and registers, for auditing) that `route` is intentionally
 * NOT ownership-gated. Throws if the justification is not one of the named
 * OWNERSHIP_EXEMPTION constants, so no exemption can be anonymous.
 */
export function exemptFromOwnership(
  route: string,
  justification: OwnershipExemption,
): RequestHandler {
  const known = Object.values(OWNERSHIP_EXEMPTION) as string[];
  if (!justification || !known.includes(justification)) {
    throw new Error(
      `exemptFromOwnership("${route}") requires a named OWNERSHIP_EXEMPTION justification constant`,
    );
  }
  exemptionRegistry.push({ route, justification });
  const mw: RequestHandler = (_req, _res, next) => next();
  (mw as any).__ownershipExempt = { route, justification };
  return mw;
}

/** Snapshot of all registered exemptions (for audit tooling / tests). */
export function listOwnershipExemptions(): ReadonlyArray<ExemptionRecord> {
  return [...exemptionRegistry];
}

/* ─────────────────────────── id extraction ──────────────────────────────── */

interface ExtractedId {
  kind: OwnershipIdKind;
  value: string;
}

/** Read the raw value for a kind from params then body, honouring aliases.
 *  Returns { present, malformed, value }. */
function readId(
  req: Request,
  kind: OwnershipIdKind,
  opts: EnforceOwnershipOptions,
): { present: boolean; malformed: boolean; value: string } {
  const paramKeys = [CANONICAL_KEYS[kind], ...(opts.paramAliases?.[kind] ?? [])];
  const bodyKeys = [CANONICAL_KEYS[kind], ...(opts.bodyAliases?.[kind] ?? [])];
  const params = (req.params ?? {}) as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;

  for (const source of [
    ...paramKeys.map((k) => params[k]),
    ...bodyKeys.map((k) => body[k]),
  ]) {
    if (source === undefined || source === null) continue;
    // Present but not a usable string ⇒ malformed (400).
    if (typeof source !== "string" || source.trim() === "") {
      return { present: true, malformed: true, value: "" };
    }
    return { present: true, malformed: false, value: source.trim() };
  }
  return { present: false, malformed: false, value: "" };
}

/* ────────────────────────── ownership resolution ────────────────────────── */

/** The recruiter's assigned-req id set, resolved once and cached on the request. */
async function assignedJobSet(
  req: Request,
  user: { id: string; role: string; tenantId: string | null },
): Promise<{ set: Set<string>; list: string[] }> {
  const cached = (req as any).__ownershipAssignedJobs as
    | { set: Set<string>; list: string[] }
    | undefined;
  if (cached) return cached;
  const list = await getRecruiterAssignedJobIds(user);
  const resolved = { set: new Set(list), list };
  (req as any).__ownershipAssignedJobs = resolved;
  return resolved;
}

/** True when the given resource resolves to a requisition the recruiter owns.
 *  A non-existent resource resolves to `false` (⇒ 404, existence hidden). */
async function isOwned(
  id: ExtractedId,
  assigned: { set: Set<string>; list: string[] },
): Promise<boolean> {
  if (assigned.list.length === 0) return false; // recruiter with no reqs owns nothing
  switch (id.kind) {
    case "jobId":
      return assigned.set.has(id.value);
    case "applicationId": {
      const [row] = await db
        .select({ jobId: applicationsTable.jobId })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, id.value))
        .limit(1);
      return !!row?.jobId && assigned.set.has(row.jobId);
    }
    case "campaignId": {
      const [row] = await db
        .select({ jobId: outreachCampaignsTable.jobId })
        .from(outreachCampaignsTable)
        .where(eq(outreachCampaignsTable.id, id.value))
        .limit(1);
      return !!row?.jobId && assigned.set.has(row.jobId);
    }
    case "candidateId": {
      // Mirrors recruiterCanAccessCandidate: reachable via an application,
      // a sourced row, or a talent-pool submission to an ASSIGNED req.
      const jobIds = assigned.list;
      const [apps, sourced, pushed] = await Promise.all([
        db
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(
            and(
              eq(applicationsTable.candidateId, id.value),
              inArray(applicationsTable.jobId, jobIds),
            ),
          )
          .limit(1),
        db
          .select({ id: sourcedCandidatesTable.id })
          .from(sourcedCandidatesTable)
          .where(
            and(
              eq(sourcedCandidatesTable.normalizedCandidateId, id.value),
              inArray(sql`${sourcedCandidatesTable.rawData}->>'jobId'`, jobIds),
            ),
          )
          .limit(1),
        db
          .select({ id: talentPoolSubmissionsTable.id })
          .from(talentPoolSubmissionsTable)
          .where(
            and(
              eq((talentPoolSubmissionsTable as any).candidateId, id.value),
              inArray((talentPoolSubmissionsTable as any).jobPostingId, jobIds),
            ),
          )
          .limit(1),
      ]);
      return apps.length > 0 || sourced.length > 0 || pushed.length > 0;
    }
  }
}

/**
 * recruiterOwnsResource(user, {kind, value}) — programmatic ownership check for
 * routes that must gate INSIDE a handler rather than via the enforceOwnership
 * middleware (e.g. the ownable id lives in the query string, or is resolved from
 * another row such as a draft's candidateId). Returns `true` for every non-
 * recruiter role — those are ceilinged by tenant scope upstream — and applies
 * the exact same assigned-requisition resolution the middleware uses. A missing
 * resource resolves to `false` (caller should 404, hiding existence).
 */
export async function recruiterOwnsResource(
  user: { id: string; role: string; tenantId: string | null },
  id: { kind: OwnershipIdKind; value: string },
): Promise<boolean> {
  if (user.role !== "recruiter") return true;
  const list = await getRecruiterAssignedJobIds(user);
  return isOwned({ kind: id.kind, value: id.value }, { set: new Set(list), list });
}

/* ────────────────────────────── middleware ──────────────────────────────── */

/**
 * enforceOwnership(opts?) — factory returning the ownership middleware. Attach
 * it AFTER resolveUser (needs req.resolvedUser) and after any existing tenant
 * guard on a route.
 */
export function enforceOwnership(opts: EnforceOwnershipOptions = {}): RequestHandler {
  const kinds = opts.kinds ?? (Object.keys(CANONICAL_KEYS) as OwnershipIdKind[]);
  const requireId = opts.requireId !== false;

  return async function ownershipMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = await resolveCaller(req);

    // Auth precondition — no valid bearer/session caller ⇒ 401. Never assume a user.
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Only a PLAIN recruiter is ceilinged by requisition assignment. Every other
    // role bypasses THIS layer — their tenant/data-scope ceiling lives elsewhere.
    if (user.role !== "recruiter") {
      next();
      return;
    }

    // Collect the ids present on this request for the configured kinds.
    const ids: ExtractedId[] = [];
    for (const kind of kinds) {
      const r = readId(req, kind, opts);
      if (r.malformed) {
        res.status(400).json({ error: "bad_request", detail: `malformed ${kind}` });
        return;
      }
      if (r.present) ids.push({ kind, value: r.value });
    }

    if (ids.length === 0) {
      if (requireId) {
        res
          .status(400)
          .json({ error: "bad_request", detail: "no ownable resource id in request" });
        return;
      }
      next();
      return;
    }

    try {
      const assigned = await assignedJobSet(req, user);
      for (const id of ids) {
        if (!(await isOwned(id, assigned))) {
          // 404 (not 403): do not confirm existence of an unowned resource.
          res.status(404).json({ error: "Not found" });
          return;
        }
      }
    } catch (err) {
      logger.error({ err }, "[ownership] enforcement failed");
      // Fail-closed on any resolution error.
      res.status(404).json({ error: "Not found" });
      return;
    }

    next();
  };
}
