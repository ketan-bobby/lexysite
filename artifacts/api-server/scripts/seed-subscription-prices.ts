/**
 * seed-subscription-prices.ts — Idempotent seed for the country pricing catalog.
 *
 * Populates subscription_prices with explicit override rows for every known
 * country × priced plan (starter/growth/enterprise) × term (monthly/quarterly/
 * annual), using the values the code rate-card would otherwise resolve. This is
 * OPTIONAL — getCountryPrice already falls back to the rate-card when no row
 * exists — but seeding gives platform admins concrete rows to edit out of the
 * box.
 *
 * Idempotent: ON CONFLICT (country, plan_code, billing_term) DO NOTHING, so
 * re-running never overwrites an admin's manual edits.
 *
 * Run (from the api-server package dir, DATABASE_URL inherited from the shell):
 *   pnpm --filter @workspace/api-server run seed:prices
 */
import { db, subscriptionPricesTable } from "@workspace/db";
import {
  rateCardCountryPrice,
  __seedKnownCountries,
  type PlanCode,
  type BillingTerm,
} from "../src/lib/plans.js";

const PLANS: PlanCode[] = ["starter", "growth", "enterprise"];
const TERMS: BillingTerm[] = ["monthly", "quarterly", "annual"];

async function main() {
  const countries = __seedKnownCountries();
  let inserted = 0;
  let skipped = 0;

  for (const country of countries) {
    for (const plan of PLANS) {
      for (const term of TERMS) {
        const p = rateCardCountryPrice(country, plan, term);
        const res = await db
          .insert(subscriptionPricesTable)
          .values({
            country: p.country,
            planCode: p.planCode,
            billingTerm: p.billingTerm,
            currency: p.currency,
            symbol: p.symbol,
            amount: p.amount,
            perSeatAmount: p.perSeatAmount,
            perHireAmount: p.perHireAmount,
            taxNote: p.taxNote,
            active: true,
          })
          .onConflictDoNothing({
            target: [
              subscriptionPricesTable.country,
              subscriptionPricesTable.planCode,
              subscriptionPricesTable.billingTerm,
            ],
          })
          .returning({ id: subscriptionPricesTable.id });
        if (res.length) inserted += 1; else skipped += 1;
      }
    }
  }

  console.log(
    `[seed-subscription-prices] done — inserted ${inserted}, skipped ${skipped} ` +
    `(countries=${countries.length}, plans=${PLANS.length}, terms=${TERMS.length})`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-subscription-prices] failed:", err);
  process.exit(1);
});
