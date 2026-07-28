/**
 * lib/linx-config.ts — resolves the LINX tenant id (server-side ONLY).
 *
 * The LINX engagement flow targets exactly one, server-configured tenant.
 * linx_tenant_id is NEVER user-selectable (see schema/linx-requests.ts):
 * a caller who could pick the target tenant could open a visibility channel
 * to an arbitrary tenant via the dual-tenant RLS policy.
 *
 * Resolution order:
 *   1. LINX_TENANT_ID env var (explicit config — wins everywhere, incl. prod)
 *   2. tenant with slug "linx-inc" (dev/default convenience)
 * Result is cached for the process lifetime; null = LINX not configured
 * (routes answer 503, they never guess).
 */
import { eq } from "drizzle-orm";
import { controlDb, tenantsTable } from "@workspace/db";

const LINX_SLUG = "linx-inc";
let cached: string | null | undefined;

export async function getLinxTenantId(): Promise<string | null> {
  const envId = process.env.LINX_TENANT_ID?.trim();
  if (envId) return envId;
  if (cached !== undefined) return cached;
  const [t] = await controlDb
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.slug, LINX_SLUG))
    .limit(1);
  cached = t?.id ?? null;
  return cached;
}

/** Test hook: clear the process cache. */
export function __resetLinxTenantCache() {
  cached = undefined;
}
