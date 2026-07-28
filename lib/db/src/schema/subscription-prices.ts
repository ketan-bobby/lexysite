/**
 * schema/subscription-prices.ts — Admin-Editable Country Pricing Catalog
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Lexy displays subscription prices at COUNTRY granularity. The tier
 * definitions (seats / usage caps / features) are IDENTICAL across every
 * country and live in code (lib/plans.ts) — only the displayed PRICE varies by
 * country. This table is the admin-editable override layer for those prices:
 * a platform_admin can change a price or add a brand-new country with NO
 * deploy. When no row exists for a (country, plan, term), the resolver in
 * lib/plans.ts (getCountryPrice) falls back to the code rate-card via
 * regionFromCountry(), so every country always resolves to a price.
 *
 * ─── Billing model ───────────────────────────────────────────────────────────
 * NO in-system payment processing. Billing is collected externally (ACH
 * today). This catalog is DISPLAY + record-keeping only. Taxes are handled
 * outside the platform — `taxNote` carries the disclosure shown in the UI
 * (e.g. "Prices exclusive of applicable VAT/GST").
 *
 * ─── Table ───────────────────────────────────────────────────────────────────
 *   subscription_prices — one row per (country, plan_code, billing_term).
 *
 * Global catalog data (no tenant_id, no RLS): readable by the app, writable
 * only by platform_admin via the gated routes in routes/subscription-prices.ts.
 *
 * `amount` / `perSeatAmount` / `perHireAmount` are stored in MAJOR currency
 * units (e.g. 799 = $799, 14999 = ₹14,999), matching the headline rate-card
 * convention in lib/plans.ts. -1 means "contact us" (no public price).
 */
import { pgTable, text, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscriptionPricesTable = pgTable(
  "subscription_prices",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    /** ISO-3166-1 alpha-2 (uppercase), e.g. "US", "IN", "GB". */
    country: text("country").notNull(),
    /** Plan code — "starter" | "growth" | "enterprise" (demo is free, never priced). */
    planCode: text("plan_code").notNull(),
    /** "monthly" | "quarterly" | "annual". */
    billingTerm: text("billing_term").notNull(),
    /** ISO 4217, e.g. "USD", "INR", "GBP". */
    currency: text("currency").notNull(),
    /** Display symbol, e.g. "$", "₹", "£". */
    symbol: text("symbol").notNull().default("$"),
    /** Platform fee for the term, in MAJOR units. -1 = "contact us". */
    amount: integer("amount").notNull(),
    /** Per-seat overage fee per MONTH, in major units. */
    perSeatAmount: integer("per_seat_amount").notNull().default(0),
    /** Per-hire fee, in major units. */
    perHireAmount: integer("per_hire_amount").notNull().default(0),
    /** Tax disclosure shown in the UI (taxes are billed externally). */
    taxNote: text("tax_note").notNull().default("Prices exclusive of applicable VAT/GST."),
    /** When false, the row is ignored by the resolver (falls back to code rate-card). */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqCountryPlanTerm: unique("subscription_prices_country_plan_term_uq").on(
      t.country,
      t.planCode,
      t.billingTerm,
    ),
  }),
);

export const insertSubscriptionPriceSchema = createInsertSchema(subscriptionPricesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectSubscriptionPriceSchema = createSelectSchema(subscriptionPricesTable);
export type InsertSubscriptionPrice = z.infer<typeof insertSubscriptionPriceSchema>;
export type SubscriptionPrice = typeof subscriptionPricesTable.$inferSelect;
