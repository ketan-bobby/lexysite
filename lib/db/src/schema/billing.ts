/**
 * schema/billing.ts — Stripe Billing Scaffolding
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Holds the minimal Stripe-side IDs we need to drive checkout, the customer
 * portal, and per-hire billing. We deliberately do NOT mirror Stripe's full
 * subscription state — Stripe is the source of truth, this table is a lookup.
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   billing_subscriptions  — one row per (tenant, Stripe subscription)
 *   billing_invoices       — one row per finalised Stripe invoice (audit trail
 *                            for what we charged a tenant — useful for the
 *                            in-app billing history page)
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   subscription_status — incomplete · trialing · active · past_due · canceled · unpaid
 *   invoice_status      — draft · open · paid · void · uncollectible
 *
 * Tenant-level Stripe customer id lives on tenants.stripeCustomerId.
 */
import { pgTable, text, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
]);

export const billingSubscriptionsTable = pgTable("billing_subscriptions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
  stripePriceId: text("stripe_price_id").notNull(),
  /** Plan code at the time of subscription (denormalised for reporting). */
  planCode: text("plan_code").notNull(),
  status: subscriptionStatusEnum("status").notNull().default("incomplete"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: text("cancel_at_period_end").notNull().default("false"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const billingInvoicesTable = pgTable("billing_invoices", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  stripeInvoiceId: text("stripe_invoice_id").notNull().unique(),
  amountDueCents: integer("amount_due_cents").notNull(),
  amountPaidCents: integer("amount_paid_cents").notNull().default(0),
  currency: text("currency").notNull().default("usd"),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  hostedInvoiceUrl: text("hosted_invoice_url"),
  invoicePdfUrl: text("invoice_pdf_url"),
  finalizedAt: timestamp("finalized_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type BillingSubscription = typeof billingSubscriptionsTable.$inferSelect;
export type BillingInvoice = typeof billingInvoicesTable.$inferSelect;
