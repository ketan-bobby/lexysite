/**
 * tenantUtils.ts — Shared Tenant Isolation Helpers
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Provides utility functions used by every route that needs to scope database
 * queries to the correct tenant(s). Centralising this logic here ensures all
 * routes apply the same visibility rules instead of reimplementing them.
 *
 * ─── Visibility model ────────────────────────────────────────────────────────
 * Tenants can be organised in a parent→child hierarchy (e.g. a staffing agency
 * parent with individual client tenants as children, grandchildren, etc.). The
 * allowed tenant set governs which rows a user may read or modify:
 *
 *   platform_admin   → null  (no filter — sees everything across all tenants)
 *   tenant admin/user → [own tenantId, ...ALL descendant tenantIds]
 *   user with no tenantId → []  (sees nothing)
 *
 * The descendant set is the ENTIRE subtree (children, grandchildren, …), not
 * just direct children. This must stay in lock-step with the RLS helper
 * app_tenant_in_scope() (migration 0021): the middleware publishes the same
 * subtree as the app.allowed_tenant_ids GUC, so app-layer WHERE clauses and
 * the database policies agree on exactly which rows are visible.
 *
 * The returned null vs. empty array distinction lets routes decide:
 *   null  → omit the WHERE tenantId IN (...) clause entirely
 *   []    → add an always-false clause so the query returns zero rows
 *   [...] → add WHERE tenantId IN ([...])
 *
 * ─── CallerUser ──────────────────────────────────────────────────────────────
 * The CallerUser interface is the minimal shape that resolveUser middleware
 * attaches to req.user. All route handlers can depend on these fields.
 */

import { db, jobsTable, jobRecruitersTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface CallerUser {
  id:       string;
  tenantId: string | null;
  role:     string;
  email:    string;
  name:     string;
}

/**
 * Collect every tenant id in the subtree rooted at `rootId` (inclusive),
 * walking the parent→child hierarchy with a recursive CTE.
 *
 * UNION (not UNION ALL) dedups, so a malformed cyclic hierarchy terminates
 * instead of looping forever. The `tenants` table is NOT RLS-protected, so
 * this returns the full subtree even when run on the request-scoped lexy_app
 * connection. Always includes `rootId` itself, even if the row is missing.
 */
export async function getSubtreeTenantIds(rootId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM tenants WHERE id = ${rootId}
      UNION
      SELECT t.id FROM tenants t
      INNER JOIN subtree s ON t.parent_id = s.id
    )
    SELECT id FROM subtree
  `);
  const list = (result as unknown as { rows?: Array<{ id: string }> }).rows
    ?? (result as unknown as Array<{ id: string }>);
  const ids = Array.isArray(list) ? list.map(r => r.id) : [];
  return ids.includes(rootId) ? ids : [rootId, ...ids];
}

/**
 * Returns the list of tenant IDs the caller is allowed to query.
 *
 * - platform_admin → null  (no filter — sees everything)
 * - everyone else   → [own tenantId, ...ALL descendant tenantIds]
 *
 * An empty array means the caller has no tenantId and should see nothing.
 *
 * This is the ENTIRE descendant subtree (children, grandchildren, …), kept in
 * lock-step with the RLS app_tenant_in_scope() policy (migration 0021).
 */
export async function getAllowedTenantIds(
  user: Pick<CallerUser, "role" | "tenantId">,
): Promise<string[] | null> {
  if (user.role === "platform_admin") return null;
  if (!user.tenantId) return [];
  return getSubtreeTenantIds(user.tenantId);
}

/**
 * Returns the set of client (sub-tenant) ids assigned to a `recruiter_admin`
 * user via the recruiter_admin_clients table.
 *
 * An empty array means the recruiter admin has no clients assigned and must
 * therefore see nothing. The lookup runs on the request-scoped lexy_app
 * connection; recruiter_admin_clients is RLS-scoped by its agency `tenant_id`
 * (app_tenant_in_scope), which is inside the caller's published subtree GUC, so
 * the caller's own assignment rows are always visible.
 */
export async function getRecruiterAdminClientTenantIds(userId: string): Promise<string[]> {
  const result = await db.execute<{ client_tenant_id: string }>(sql`
    SELECT client_tenant_id FROM recruiter_admin_clients
    WHERE recruiter_admin_user_id = ${userId}
  `);
  const list = (result as unknown as { rows?: Array<{ client_tenant_id: string }> }).rows
    ?? (result as unknown as Array<{ client_tenant_id: string }>);
  return Array.isArray(list) ? list.map(r => r.client_tenant_id).filter(Boolean) : [];
}

/**
 * Returns the set of client (sub-tenant) ids covered by the recruiters who
 * REPORT TO a `recruiter_admin` via the recruiter_managers table — i.e. the
 * client tenants of every work order those managed recruiters are assigned to.
 *
 * Reporting links come in two flavours (see schema/recruiter-managers.ts):
 *   • jobId NULL  → DEFAULT reporting: the admin supervises the recruiter across
 *     ALL of their assigned work orders → include the tenant of every job the
 *     recruiter is assigned to (primary assigned_recruiter_id OR job_recruiters).
 *   • jobId set   → per-work-order OVERRIDE: include only that single job's tenant.
 *
 * This is the reporting-link half of the recruiter_admin data scope; it is
 * UNIONed with getRecruiterAdminClientTenantIds (the direct client-assignment
 * half) and intersected with the agency subtree ceiling in getDataScopeTenantIds.
 * Runs on the request-scoped lexy_app connection; recruiter_managers is
 * RLS-scoped by its agency tenant_id, which is inside the caller's subtree GUC.
 */
export async function getManagedRecruiterClientTenantIds(userId: string): Promise<string[]> {
  const result = await db.execute<{ tenant_id: string }>(sql`
    -- Per-work-order override links: the specific job's tenant.
    SELECT j.tenant_id AS tenant_id
    FROM recruiter_managers rm
    JOIN jobs j ON j.id = rm.job_id
    WHERE rm.recruiter_admin_user_id = ${userId}
      AND rm.job_id IS NOT NULL
    UNION
    -- Default links: every tenant of a job the managed recruiter is assigned to
    -- as PRIMARY recruiter. EXCLUDE jobs that carry a per-work-order override for
    -- this recruiter — an override supersedes the default reporting for that job,
    -- so the default admin must not inherit it (schema/recruiter-managers.ts).
    SELECT j.tenant_id AS tenant_id
    FROM recruiter_managers rm
    JOIN jobs j ON j.assigned_recruiter_id = rm.recruiter_user_id
    WHERE rm.recruiter_admin_user_id = ${userId}
      AND rm.job_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM recruiter_managers ov
        WHERE ov.recruiter_user_id = rm.recruiter_user_id AND ov.job_id = j.id
      )
    UNION
    -- Default links: every tenant of a job the managed recruiter is on via the
    -- job_recruiters roster (additional-recruiter staffing). Same override guard.
    SELECT j.tenant_id AS tenant_id
    FROM recruiter_managers rm
    JOIN job_recruiters jr ON jr.recruiter_user_id = rm.recruiter_user_id
    JOIN jobs j ON j.id = jr.job_id
    WHERE rm.recruiter_admin_user_id = ${userId}
      AND rm.job_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM recruiter_managers ov
        WHERE ov.recruiter_user_id = rm.recruiter_user_id AND ov.job_id = j.id
      )
  `);
  const list = (result as unknown as { rows?: Array<{ tenant_id: string }> }).rows
    ?? (result as unknown as Array<{ tenant_id: string }>);
  return Array.isArray(list) ? list.map(r => r.tenant_id).filter(Boolean) : [];
}

/**
 * Returns the client (sub-tenant) ids of work orders the caller is PERSONALLY
 * staffed on — as primary recruiter (jobs.assigned_recruiter_id) or via the
 * job_recruiters roster. A recruiter_admin who also carries requisitions
 * themselves (a working manager) must see those clients even with no
 * recruiter_admin_clients rows and no managed recruiters.
 * Third half of the recruiter_admin data-scope union in getDataScopeTenantIds;
 * intersected there with the agency subtree ceiling.
 */
export async function getOwnAssignedJobTenantIds(userId: string): Promise<string[]> {
  const result = await db.execute<{ tenant_id: string }>(sql`
    SELECT j.tenant_id AS tenant_id
    FROM jobs j
    WHERE j.assigned_recruiter_id = ${userId}
    UNION
    SELECT j.tenant_id AS tenant_id
    FROM job_recruiters jr
    JOIN jobs j ON j.id = jr.job_id
    WHERE jr.recruiter_user_id = ${userId}
  `);
  const list = (result as unknown as { rows?: Array<{ tenant_id: string }> }).rows
    ?? (result as unknown as Array<{ tenant_id: string }>);
  return Array.isArray(list) ? list.map(r => r.tenant_id).filter(Boolean) : [];
}

/**
 * The authoritative DATA visibility ceiling for a caller, used by every
 * row-listing route (jobs, candidates, …) so they all agree.
 *
 *   platform_admin   → null  (no filter — sees everything)
 *   recruiter_admin  → client sub-tenants linked via assignments, managed
 *                      recruiters, or their OWN staffed jobs ([] ⇒ nothing)
 *   everyone else    → getAllowedTenantIds (own tenant + full subtree)
 *
 * A recruiter admin's RLS GUC still publishes the full agency subtree (so they
 * can read/write their assignment rows and manage staff in the agency tenant);
 * this helper is the narrower APP-LAYER ceiling applied to candidate/job data.
 * It never widens beyond getAllowedTenantIds.
 */
export async function getDataScopeTenantIds(
  user: Pick<CallerUser, "id" | "role" | "tenantId">,
): Promise<string[] | null> {
  if (user.role === "platform_admin") return null;
  if (user.role === "recruiter_admin") {
    if (!user.tenantId) return [];
    // Data scope is the UNION of three halves:
    //   1. Directly-assigned clients (recruiter_admin_clients).
    //   2. Clients their managed recruiters (recruiter_managers) are assigned to.
    //   3. Clients of work orders the admin is PERSONALLY staffed on (a
    //      "working manager" who also carries requisitions).
    // A recruiter_admin sees a client if ANY of the three links them to it.
    const [clients, managed, own] = await Promise.all([
      getRecruiterAdminClientTenantIds(user.id),
      getManagedRecruiterClientTenantIds(user.id),
      getOwnAssignedJobTenantIds(user.id),
    ]);
    const union = new Set([...clients, ...managed, ...own]);
    if (union.size === 0) return [];
    // Intersect with the agency subtree as a hard ceiling — a stale assignment
    // row pointing outside the agency must never widen visibility.
    const subtree = await getSubtreeTenantIds(user.tenantId);
    const allowedSet = new Set(subtree);
    return [...union].filter(id => allowedSet.has(id));
  }
  return getAllowedTenantIds(user);
}

/**
 * The set of requisition (job) ids ASSIGNED to a plain `recruiter` — i.e. jobs
 * whose assigned_recruiter_id is the caller, within their agency subtree.
 *
 * This is the authoritative ownership ceiling for a recruiter: a recruiter may
 * only see/act on candidates tied to one of these requisitions. Returns [] for
 * any non-recruiter role (callers gate those via getDataScopeTenantIds) and for
 * a recruiter with no assigned reqs (⇒ sees/does nothing).
 *
 * A recruiter is assigned to a req when they are the PRIMARY recruiter
 * (jobs.assigned_recruiter_id) OR appear in the job_recruiters join table for
 * that req (multi-recruiter staffing). Both sources are intersected with the
 * agency subtree as a hard ceiling — a stale join row pointing at a job outside
 * the subtree must never widen visibility.
 *
 * Centralised here so every candidate read/write-by-id route applies the same
 * rule the GET /candidates list already enforces inline.
 */
export async function getRecruiterAssignedJobIds(
  user: Pick<CallerUser, "id" | "role" | "tenantId">,
): Promise<string[]> {
  if (user.role !== "recruiter" || !user.tenantId) return [];
  const subtree = await getSubtreeTenantIds(user.tenantId);
  if (subtree.length === 0) return [];
  // Primary-recruiter reqs.
  const primaryRows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(inArray(jobsTable.tenantId, subtree), eq(jobsTable.assignedRecruiterId, user.id)));
  // Join-table (additional-recruiter) reqs — join back to jobsTable so the
  // subtree ceiling is enforced against the JOB's tenant, not the (possibly
  // stale) tenant stamped on the assignment row.
  const joinRows = await db
    .select({ id: jobsTable.id })
    .from(jobRecruitersTable)
    .innerJoin(jobsTable, eq(jobRecruitersTable.jobId, jobsTable.id))
    .where(and(inArray(jobsTable.tenantId, subtree), eq(jobRecruitersTable.recruiterUserId, user.id)));
  const ids = new Set<string>();
  for (const r of primaryRows) ids.add(r.id);
  for (const r of joinRows) ids.add(r.id);
  return [...ids];
}

/**
 * True when a plain `recruiter` is assigned to a specific req — primary recruiter
 * OR a member of the job_recruiters join table. Used by the job-level direct
 * gates in routes/jobs.ts (the join table can't be checked inline the way a
 * scalar assigned_recruiter_id column can). Callers must still enforce the
 * tenant ceiling separately; this only answers the recruiter-membership part.
 */
export async function recruiterIsAssignedToJob(
  userId: string,
  job: { id: string; assignedRecruiterId: string | null },
): Promise<boolean> {
  if (job.assignedRecruiterId === userId) return true;
  const [row] = await db
    .select({ id: jobRecruitersTable.id })
    .from(jobRecruitersTable)
    .where(and(eq(jobRecruitersTable.jobId, job.id), eq(jobRecruitersTable.recruiterUserId, userId)))
    .limit(1);
  return !!row;
}

/**
 * Justification tag for READ paths that intentionally scan agency-wide (the
 * caller's full subtree / data scope) instead of being narrowed to a recruiter's
 * assigned requisitions.
 *
 * Talent rediscovery and sourcing-recommendation *reads* are a deliberate
 * feature: a recruiter must be able to discover matching candidates across the
 * agency pool, not just on reqs already assigned to them. The corresponding
 * WRITES that attach/apply/save a candidate or artifact to a requisition are
 * still gated on assignment — see the write gates in the talent_match / sourcing
 * routes. Pass this to readScopeExemption() at the top of an exempt read handler
 * so the deviation from the standard ownership gate is greppable and reviewable.
 */
export const TALENT_REDISCOVERY =
  "read-only talent rediscovery: agency-wide candidate discovery is intentional; writes still require requisition assignment";

/**
 * SOURCED_POOL_VISIBILITY — read-scope exemption for the tenant's SHARED sourced
 * candidate pool. GET /sourcing/candidates lists the whole tenant (subtree) pool
 * so a recruiter can browse it to find matches for their reqs — that is the
 * feature working, and it is the same asymmetry as TALENT_REDISCOVERY: reads are
 * tenant/agency-wide, WRITES (merge, source-onto-req) still require requisition
 * assignment. Ratified sourced-pool product decision (sibling of row 14).
 */
export const SOURCED_POOL_VISIBILITY =
  "read-only sourced-pool visibility: the tenant's shared sourced candidate pool is browsable tenant-wide; writes (merge, source-onto-req) still require requisition assignment";

/**
 * No-op documentation marker for a read path that intentionally deviates from
 * the standard recruiter-ownership gate (agency-wide discovery). Exists so the
 * justification constant is genuinely referenced in code and so every exemption
 * is discoverable via grep during a security review.
 */
export function readScopeExemption(_reason: string): void {
  /* intentionally empty — documentation marker only */
}
