/**
 * region.ts — Region helpers for the API server
 *
 * Thin app-layer helpers that the tenant routes (and any other handler
 * that needs to assert residency invariants) compose. The single source
 * of truth for the closed enum lives in @workspace/db; we re-export the
 * type here so handlers can `import { Region } from "../lib/region"`
 * without reaching into the db package.
 */
import { eq } from "drizzle-orm";
import { controlDb, tenantsTable, type Region, REGIONS, isRegion } from "@workspace/db";

export type { Region };
export { REGIONS, isRegion };

/**
 * Look up a tenant's region. Uses controlDb because the tenant directory
 * lives in the control plane — region routing has to be answerable before
 * we know which cell to route to.
 */
export async function getTenantRegion(tenantId: string): Promise<Region | null> {
  const [row] = await controlDb
    .select({ region: tenantsTable.region })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);
  return (row?.region as Region) ?? null;
}

/**
 * Throw if `childRegion` differs from `parentRegion`. Used by the tenant
 * creation handler to refuse cross-region nesting (Acme-India can't have a
 * subsidiary in the US cell — that would violate the cell-per-tenant model
 * we committed to in Phase 0).
 */
export function assertChildRegionMatches(parentRegion: Region, childRegion: Region): void {
  if (parentRegion !== childRegion) {
    const err: any = new Error(
      `Region mismatch: child tenant region '${childRegion}' must match parent region '${parentRegion}'. ` +
        `Multi-region nesting is not supported — create a separate root tenant in the desired region instead.`,
    );
    err.status = 400;
    err.code = "REGION_MISMATCH";
    throw err;
  }
}
