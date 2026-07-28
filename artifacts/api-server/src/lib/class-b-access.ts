/**
 * class-b-access.ts — the CANONICAL scoped-accessor module for the two HIGH_RISK
 * Class-B tables (candidate_job_intelligence, hiring_manager_shares).
 *
 * These two tables were the confirmed employer-facing leaks of the 2026-07 audit.
 * Because they have NO database-level tenant isolation (Class B — no RLS in dev
 * OR prod), a raw read with the wrong `where` silently returns another tenant's
 * rows. `check-classb-read.mjs` therefore demands, for these two tables, that the
 * tenant filter be expressed through one of the helpers BELOW rather than an
 * ad-hoc `.tenantId` column — a distinct, greppable token a stray select/orderBy
 * projection cannot accidentally satisfy (closing the FN-1 hole for these two).
 *
 * Each helper RETURNS a drizzle SQL predicate to drop into a `.where(and(...))`;
 * it does not run the query. It is fail-CLOSED: an empty allow-list yields a
 * false predicate (zero rows), never an unscoped read.
 *
 * `scope` follows the getDataScopeTenantIds() contract used across the app:
 *   • null        → platform_admin: no tenant restriction (sees all rows)
 *   • string[]    → the caller's tenant subtree (may be empty ⇒ nothing visible)
 */
import { inArray, sql, type SQL } from "drizzle-orm";
import {
  candidateJobIntelligenceTable,
  hiringManagerSharesTable,
} from "@workspace/db";

export type TenantScope = string[] | null;

const ALL_ROWS = sql`true`;
const NO_ROWS = sql`false`;

function tenantPredicate(column: any, scope: TenantScope): SQL {
  if (scope === null) return ALL_ROWS;
  if (scope.length === 0) return NO_ROWS;
  return inArray(column, scope);
}

/**
 * Tenant-scope predicate for candidate_job_intelligence. Drop into the read's
 * `.where(and(intelTenantScope(scope), ...))`. Pass the value returned by
 * getDataScopeTenantIds(user) (null for platform_admin).
 */
export function intelTenantScope(scope: TenantScope): SQL {
  return tenantPredicate(candidateJobIntelligenceTable.tenantId, scope);
}

/**
 * Tenant-scope predicate for hiring_manager_shares (staff-facing list reads).
 * For a single share fetched by opaque token, use a `classBRead(TOKEN_PRE_AUTHORIZED)`
 * exemption instead — token validation, not a tenant column, is the gate there.
 */
export function hmShareScope(scope: TenantScope): SQL {
  return tenantPredicate(hiringManagerSharesTable.tenantId, scope);
}
