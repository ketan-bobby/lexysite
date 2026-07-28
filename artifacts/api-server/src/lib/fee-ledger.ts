/**
 * lib/fee-ledger.ts — Per-hire fee line-item creation (no payment processor)
 *
 * Called (best-effort, non-blocking) from the accept-offer outcome handler.
 * Creates ONE fee_line_items row per fee-eligible accepted offer:
 *
 *   ELIGIBLE  ⟺  application.entry_type = 'sourced'
 *             AND application.origin_evidence IS NOT NULL
 *             AND evidence channel is 'ai_sourcing' or 'linx'
 *
 * Pre-launch entries (no evidence) and customer/inbound entries never create
 * a line item. All new items land in 'pending_review' — a platform_admin
 * reviews before anything is exported for external invoicing. The platform
 * NEVER charges anyone; this is a system of record only.
 *
 * Failures here must never break the hiring flow: log and return null.
 */
import { db, feeLineItemsTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCountryPrice, type PlanCode } from "./plans";
import { logger } from "./logger";

const FEE_CHANNELS = new Set(["ai_sourcing", "linx"]);

/**
 * Pure eligibility predicate — the single source of truth shared by the
 * accept-offer hook and the staff correction reconcile path.
 * Pre-launch rows (NULL evidence) are NEVER eligible.
 */
export function isFeeEligible(
  entryType: string | null | undefined,
  originEvidence: unknown,
): boolean {
  if (entryType !== "sourced") return false;
  if (!originEvidence || typeof originEvidence !== "object") return false;
  return FEE_CHANNELS.has(String((originEvidence as any).channel ?? ""));
}

export async function createFeeLineItemIfEligible(app: {
  id: string;
  tenantId: string | null;
  candidateId: string;
  jobId: string | null;
  entryType?: string | null;
  originEvidence?: unknown;
}): Promise<{ id: string } | null> {
  try {
    if (!isFeeEligible(app.entryType, app.originEvidence)) return null;
    const evidence = app.originEvidence as Record<string, unknown>;
    const channel = String((evidence as any).channel ?? "");
    if (!app.tenantId || !app.jobId) return null;

    // Resolve the tenant's plan + country → per-hire fee at accept time.
    const [tenant] = await db
      .select({ plan: tenantsTable.plan, country: tenantsTable.country })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, app.tenantId))
      .limit(1);
    if (!tenant) return null;

    const price = await getCountryPrice(tenant.country, tenant.plan as PlanCode, "monthly");
    if (!price.perHireAmount || price.perHireAmount <= 0) {
      logger.info(
        { applicationId: app.id, plan: tenant.plan },
        "Fee-eligible hire but plan has no per-hire fee — no line item",
      );
      return null;
    }

    // One line item per application — the unique index makes re-accepts a no-op.
    const [item] = await db
      .insert(feeLineItemsTable)
      .values({
        tenantId: app.tenantId,
        applicationId: app.id,
        candidateId: app.candidateId,
        jobId: app.jobId,
        planCode: String(tenant.plan),
        amount: price.perHireAmount,
        currency: price.currency,
        originChannel: channel,
        evidence: evidence,
        status: "pending_review",
      })
      .onConflictDoNothing({ target: feeLineItemsTable.applicationId })
      .returning({ id: feeLineItemsTable.id });

    if (item) {
      logger.info(
        {
          feeLineItemId: item.id,
          applicationId: app.id,
          channel,
          amount: price.perHireAmount,
          currency: price.currency,
        },
        "Per-hire fee line item created (pending_review)",
      );
    }
    return item ?? null;
  } catch (err) {
    // Never break the hiring flow over ledger bookkeeping.
    logger.error(
      { err, applicationId: app.id },
      "Failed to create fee line item (hire flow unaffected)",
    );
    return null;
  }
}
