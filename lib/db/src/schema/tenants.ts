/**
 * schema/tenants.ts — Tenant (Client Organisation) Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   tenants   — One row per organisation using Lexy. Supports a parent→child
 *               hierarchy (a staffing agency parent with individual client child
 *               tenants). Stores branding (primaryColor, logoUrl), billing plan,
 *               contact info, and feature flags (candidateDatabaseAccess,
 *               platformRecommendationsEnabled, autoSendSafeReplies).
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   tenant_plan   — demo · starter · growth · enterprise
 *   tenant_status — active · suspended · trial
 *   tenant_type   — direct · agency · branch · enterprise · sub_client
 *
 * Plan packages (limits, features, pricing) are defined in
 * artifacts/api-server/src/lib/plans.ts — that file is the source of truth for
 * what each plan includes. Limits are enforced at request time by
 * lib/plan-enforcement.ts.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/tenants.ts        — full CRUD and hierarchy management
 *   lib/tenantUtils.ts       — getAllowedTenantIds() visibility scoping
 */
import { pgTable, text, timestamp, integer, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantPlanEnum = pgEnum("tenant_plan", ["demo", "starter", "growth", "enterprise"]);
/** Lifecycle status. `past_due` is the grace window after paid_through_at lapses
 *  but before the grace period expires — the tenant is still allowed to work.
 *  `suspended` is hard-blocked (set automatically once grace runs out, or
 *  manually by a platform_admin). See lib/subscription-lifecycle-scheduler.ts. */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended", "trial", "past_due"]);
export const tenantTypeEnum = pgEnum("tenant_type", ["direct", "agency", "branch", "enterprise", "sub_client"]);
/** Multi-region Phase 0: closed enum of supported data-residency cells.
 *  See .local/docs/multi-region-phase-0.md and lib/db/src/db-router.ts.
 *  Adding a region here is the trigger to add a physical cell in Phase 1. */
export const tenantRegionEnum = pgEnum("tenant_region", ["us", "in", "eu", "uk", "au", "ca"]);
export type TenantRegion = "us" | "in" | "eu" | "uk" | "au" | "ca";
/** Billing cadence on the contract. Sales-led only — no in-app customer
 *  toggle. 'monthly' is the default; 'annual' is set by the platform_admin
 *  (or the billing webhook) once a signed annual contract is in place and
 *  drives which Stripe Price ID set is used for checkout (see plans.ts). */
export const tenantBillingTermEnum = pgEnum("tenant_billing_term", ["monthly", "quarterly", "annual"]);
export type TenantBillingTerm = "monthly" | "quarterly" | "annual";

export const tenantsTable = pgTable("tenants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  parentId: text("parent_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color"),
  plan: tenantPlanEnum("plan").notNull().default("starter"),
  status: tenantStatusEnum("status").notNull().default("trial"),
  clientType: tenantTypeEnum("client_type").notNull().default("direct"),
  industry: text("industry"),
  website: text("website"),
  contactEmail: text("contact_email"),
  address: text("address"),
  candidateDatabaseAccess: boolean("candidate_database_access").notNull().default(false),
  // When true, Outreach Conversation Agent drafts classified as
  // "safe_to_send" (purely informational answers) are sent to candidates
  // automatically. When false (default), every draft requires a recruiter
  // to approve in the inbox. Recommended: keep false for the first 2 weeks
  // after rollout, then flip on once the AI's classifications are trusted.
  autoSendSafeReplies: boolean("auto_send_safe_replies").notNull().default(false),
  /** Geographic region — drives data-residency cell routing (Phase 0), regional
   *  pricing, and partner rev-share caps. Closed enum: us, in, eu, uk, au, ca.
   *  Immutable after creation; children inherit from parent (enforced in
   *  routes/tenants.ts). See lib/db/src/db-router.ts. */
  region: tenantRegionEnum("region").notNull().default("us"),
  /** Billing COUNTRY — ISO-3166-1 alpha-2 (uppercase, e.g. "US", "IN", "GB").
   *  SEPARATE from `region` (which is data-residency). Drives country-level
   *  price DISPLAY via the subscription_prices catalog (see
   *  lib/plans.ts getCountryPrice). Nullable: null = "pending" (admin must
   *  set it — used for tenants backfilled from an ambiguous region bucket).
   *  Immutable after creation; children inherit from parent (enforced in
   *  routes/tenants.ts). Does NOT change entitlements — tiers are identical
   *  across countries, only the displayed price varies. */
  country: text("country"),
  /** Timestamp of the most recent plan change. Drives plan-expiry math (instead
   *  of tenant.createdAt, so a customer who later moves to a demo plan still
   *  gets the full demo window from the move-in date). Defaults to createdAt. */
  planActivatedAt: timestamp("plan_activated_at").notNull().defaultNow(),
  /** Stripe customer id (cus_*) — populated lazily on first checkout/portal use. */
  stripeCustomerId: text("stripe_customer_id"),
  /** Trial-expiry email idempotency timestamps — set by trial-expiry-scheduler.
   *  Each is non-null once the corresponding warning email has been sent so the
   *  scheduler doesn't re-send on every tick. Only meaningful while plan='demo'. */
  trialWarning3dSentAt: timestamp("trial_warning_3d_sent_at"),
  trialWarning1dSentAt: timestamp("trial_warning_1d_sent_at"),
  trialExpiredEmailSentAt: timestamp("trial_expired_email_sent_at"),
  /** Billing cadence — set by sales on contract signing. Drives which Stripe
   *  Price ID set is used at checkout (monthly vs. annual). No customer-facing
   *  toggle; surfaced read-only as a badge on /recruiter/subscription. */
  billingTerm: tenantBillingTermEnum("billing_term").notNull().default("monthly"),
  /** Manual / sales-led billing override. When non-null, this is the date
   *  through which the tenant has paid per a signed contract or PO. The
   *  plan-enforcement layer (lib/plan-enforcement.ts) treats `paid_through_at
   *  < now()` as plan-expired, identically to `status='suspended'`. When
   *  null, expiry falls back to plan_activated_at + plan.expiresAfterDays
   *  (the original demo-trial behaviour). Only platform_admin can write this. */
  paidThroughAt: timestamp("paid_through_at", { withTimezone: true }),
  /** Per-tenant grace-period override (days after paid_through_at before hard
   *  block). Null = global SUBSCRIPTION_GRACE_DAYS default. Written only by
   *  POST /tenants/:id/grace-period (platform_admin, reason required, audit
   *  line appended to billingNotes). Enterprise contracts negotiate this. */
  gracePeriodDays: integer("grace_period_days"),
  /** Operator-only free-text billing context (PO #, AP contact, deal owner,
   *  etc.). NEVER returned to tenant_admins or recruiters. */
  billingNotes: text("billing_notes"),
  /** Renewal-reminder idempotency (set by subscription-lifecycle-scheduler).
   *  `renewalReminderSentAt` is non-null once the platform-admin "approaching
   *  expiry" notification has been sent for the CURRENT paid-through cycle.
   *  `renewalLapsedNotifiedAt` is non-null once the "lapsed / past_due"
   *  notification has been sent for the current cycle. Both are cleared
   *  (set back to NULL) whenever paid_through_at is extended via
   *  POST /tenants/:id/record-payment, so the next cycle warns again. */
  renewalReminderSentAt: timestamp("renewal_reminder_sent_at", { withTimezone: true }),
  renewalLapsedNotifiedAt: timestamp("renewal_lapsed_notified_at", { withTimezone: true }),
  /** Optional: which partner referred this tenant (FK by convention to partners.id). */
  partnerId: text("partner_id"),
  createdById: text("created_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const selectTenantSchema = createSelectSchema(tenantsTable);
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
