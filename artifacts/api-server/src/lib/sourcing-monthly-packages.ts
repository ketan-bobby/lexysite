import { eq } from "drizzle-orm";
import { controlDb, tenantsTable } from "@workspace/db";
import { getPlan, getCountryPrice } from "./plans";

/** Display only. Never activates a plan, resets credits, or grants paid dispatch. */
export async function getSourcingMonthlyPackages(tenantId: string) {
  // Job access is gated by the caller. Read only its billing ancestry; child
  // tenants inherit the root contract, not their possibly stale plan snapshot.
  let cursor = tenantId;
  const seen = new Set<string>();
  let root;
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const [row] = await controlDb
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, cursor))
      .limit(1);
    if (!row) return null;
    if (!row.parentId) {
      root = row;
      break;
    }
    cursor = row.parentId;
  }
  if (!root) return null;
  const country = root.country ?? null;
  const tiers = await Promise.all(
    (["starter", "growth", "enterprise"] as const).map(async (code) => {
      const plan = getPlan(code);
      const price = await getCountryPrice(country, code, "monthly");
      return {
        code,
        name: plan.name,
        amount: price.amount,
        currency: price.currency,
        symbol: price.symbol,
        taxNote: price.taxNote,
        priceSource: price.source,
        maxOpenJobs: plan.limits.maxOpenJobs,
        maxStaffSeats: plan.limits.maxStaffSeats,
        candidateDbSearchesPerMonth: plan.limits.maxCandidateDbSearchesPerMonth,
        aiGenerationsPerMonth: plan.limits.maxAiGenerationsPerMonth,
      };
    }),
  );
  return {
    country,
    currentPlan: root.plan,
    billingTerm: root.billingTerm ?? "monthly",
    displayTerm: "monthly" as const,
    sourcingAllowanceConfigured: false as const,
    tiers,
    note: "Monthly platform-price references for the existing company plans, not a new charge or contract change. Country catalog prices apply; missing country uses US catalog references only. Existing seat/per-hire fees and tax terms remain separate. Monthly external-sourcing allowances are not configured or enforced by this display. Paid autonomous execution remains locked.",
  };
}
