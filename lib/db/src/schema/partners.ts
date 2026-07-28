/**
 * schema/partners.ts — Partner Program (Rev-Share Affiliates)
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * L3xy's growth model relies on staffing-agency and consultant partners who
 * refer clients in exchange for a percentage of recurring revenue. The partner
 * program enforces:
 *   • A regional rev-share cap (US 30% / EU 25% / India 20% / Africa 15%) — see
 *     §10.7 of L3xy_Unit_Economics_and_Pricing.md.
 *   • A hard 35% net-margin floor — payouts are clipped if they would push a
 *     deal under the floor.
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   partners                     — one row per registered partner
 *   partner_attribution_events   — one row per "tenant X attributed to partner Y"
 *                                  with the agreed rev-share rate at that time
 *   partner_payouts              — one row per monthly payout calculation
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   partner_status — pending · active · suspended · churned
 *   partner_region — us · eu · india · africa · pakistan · other
 *   payout_status  — pending · approved · paid · cancelled
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/partners.ts        — CRUD, attribution, payout calculation
 *   tenants.partner_id        — FK-by-convention pointing to partners.id
 */
import { pgTable, text, timestamp, integer, pgEnum, numeric, boolean, jsonb } from "drizzle-orm/pg-core";

export const partnerStatusEnum = pgEnum("partner_status", ["pending", "active", "suspended", "churned"]);
export const partnerRegionEnum = pgEnum("partner_region", ["us", "eu", "india", "africa", "pakistan", "other"]);
export const payoutStatusEnum = pgEnum("payout_status", ["pending", "approved", "paid", "cancelled"]);

export const partnersTable = pgTable("partners", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  contactEmail: text("contact_email").notNull().unique(),
  companyName: text("company_name"),
  region: partnerRegionEnum("region").notNull().default("us"),
  status: partnerStatusEnum("status").notNull().default("pending"),
  /** Negotiated rev-share % (0-100). Capped server-side by the regional matrix
   *  in lib/partner-payouts.ts so a misconfigured value can never break the
   *  35% net-margin floor. Stored as a percentage (e.g. 25 = 25%). */
  revSharePct: numeric("rev_share_pct", { precision: 5, scale: 2 }).notNull().default("20.00"),
  /** Optional payout details (PayPal email, bank reference, etc.). Free-form
   *  JSON since formats vary per region — never logged. */
  payoutMethod: jsonb("payout_method"),
  notes: text("notes"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const partnerAttributionEventsTable = pgTable("partner_attribution_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  partnerId: text("partner_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  /** The rev-share rate locked in at attribution time (so historical payouts
   *  remain stable even if the partner's headline rate later changes). */
  revSharePctAtAttribution: numeric("rev_share_pct_at_attribution", { precision: 5, scale: 2 }).notNull(),
  attributedAt: timestamp("attributed_at").notNull().defaultNow(),
});

export const partnerPayoutsTable = pgTable("partner_payouts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  partnerId: text("partner_id").notNull(),
  /** Period this payout covers, in YYYY-MM form. */
  periodMonth: text("period_month").notNull(),
  /** Total attributed tenant revenue in cents (USD). */
  attributedRevenueCents: integer("attributed_revenue_cents").notNull(),
  /** Calculated rev-share before margin-floor clipping (cents). */
  rawPayoutCents: integer("raw_payout_cents").notNull(),
  /** Final payout after the 35% net-margin floor is applied (cents). */
  payoutCents: integer("payout_cents").notNull(),
  /** True iff the margin floor reduced the payout. Visible to platform_admin. */
  marginFloorApplied: boolean("margin_floor_applied").notNull().default(false),
  status: payoutStatusEnum("status").notNull().default("pending"),
  /** Ad-hoc detail / dispute notes from the platform_admin reviewing the row. */
  notes: text("notes"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Partner = typeof partnersTable.$inferSelect;
export type PartnerAttributionEvent = typeof partnerAttributionEventsTable.$inferSelect;
export type PartnerPayout = typeof partnerPayoutsTable.$inferSelect;
