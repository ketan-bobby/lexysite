/**
 * schema/fee-ledger.ts — Per-Hire Fee Ledger (no payment processor)
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * L3XY charges a per-hire success fee ONLY when L3XY's own sourcing found the
 * candidate (AI sourcing agent or LINX partner sourcing) — never for
 * customer-imported or inbound-application candidates. The platform is the
 * SYSTEM OF RECORD for fee eligibility; invoicing happens OUTSIDE the platform
 * (external invoices, manual payment recording). The platform never charges
 * anyone directly.
 *
 * ─── Fee-eligibility rule (fail-closed) ─────────────────────────────────────
 * A line item is created on offer-acceptance IFF the application row has
 *   entry_type = 'sourced' AND origin_evidence IS NOT NULL.
 * origin_evidence is only captured going forward (launch of this feature), so
 * pre-launch entries are structurally excluded from fees — no reconstructed
 * evidence, no retroactive billing. Bugs cost us revenue, never a wrong charge.
 *
 * ─── Lifecycle (all transitions are manual staff actions, audited) ──────────
 *   pending_review → approved → invoiced_externally → paid
 *                  ↘ waived / disputed (tenant "Dispute this fee" flips to
 *                    disputed; excluded from exports until staff resolves)
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   fee_line_items      — one row per fee-eligible accepted offer
 *   origin_corrections  — permanent audit of staff sourcing-origin corrections
 *
 * Class-B (app-code tenant seal): staff routes are platform_admin-gated; the
 * tenant-facing read routes apply an explicit tenant predicate.
 */
import { pgTable, text, timestamp, real, jsonb, pgEnum } from "drizzle-orm/pg-core";

export const feeLineItemStatusEnum = pgEnum("fee_line_item_status", [
  "pending_review",
  "approved",
  "waived",
  "disputed",
  "invoiced_externally",
  "paid",
]);

export const feeLineItemsTable = pgTable("fee_line_items", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  /** Ledger line kind. 'per_hire' rows must carry the full hire identity
   *  (DB CHECK fee_line_items_per_hire_shape); the other kinds are money-only:
   *    'proration'    — plan-change delta ((new−old) × remaining_days/30)
   *    'adjustment'   — partial payment / credit / refund recorded manually
   *    'seat_overage' — monthly sweep of active seats above the plan's cap */
  itemType: text("item_type").notNull().default("per_hire"),
  /** One line item per application (accepted offer). NULL for non-hire kinds. */
  applicationId: text("application_id").unique(),
  candidateId: text("candidate_id"),
  jobId: text("job_id"),
  /** Plan code at accept time (denormalised — plans can change later). */
  planCode: text("plan_code"),
  /** Amount in `currency`. Negative = credit/refund toward the tenant. */
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  /** Sourcing channel that earned the fee: 'ai_sourcing' | 'linx'. NULL for non-hire kinds. */
  originChannel: text("origin_channel"),
  /** per_hire: snapshot of origin_evidence. Other kinds: structured metadata
   *  (e.g. { paymentType, oldPlan, newPlan, seats } — audit context). */
  evidence: jsonb("evidence"),
  /** Human-readable line description shown in the review queue + CSV. */
  description: text("description"),
  /** Dedup key for periodic emitters — 'YYYY-MM' for seat_overage (partial
   *  unique index fee_line_items_seat_overage_period_uq is the claim). */
  periodKey: text("period_key"),
  status: feeLineItemStatusEnum("status").notNull().default("pending_review"),
  /* ── Staff review trail ── */
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewReason: text("review_reason"),
  /* ── Tenant dispute ── */
  disputedBy: text("disputed_by"),
  disputedAt: timestamp("disputed_at", { withTimezone: true }),
  disputeReason: text("dispute_reason"),
  /* ── External invoicing (manual, outside the platform) ── */
  externalInvoiceRef: text("external_invoice_ref"),
  externalInvoiceDate: timestamp("external_invoice_date", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Permanent audit record for staff corrections of sourcing origin. */
export const originCorrectionsTable = pgTable("origin_corrections", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  applicationId: text("application_id").notNull(),
  /** Old/new snapshots: { entryType, originEvidence } */
  oldValue: jsonb("old_value").notNull(),
  newValue: jsonb("new_value").notNull(),
  changedBy: text("changed_by").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Per-cycle dunning-alert claim table (replaces the single-shot
 *  renewal_reminder_sent_at / renewal_lapsed_notified_at columns).
 *  cycle_anchor = the paid_through_at ISO string the alert was measured
 *  against — advancing paid_through_at (record-payment) starts a new cycle,
 *  so every threshold re-arms automatically. The UNIQUE(tenant_id,
 *  cycle_anchor, alert_type) constraint is the atomic claim: the scheduler
 *  INSERTs ... ON CONFLICT DO NOTHING and only sends when the insert won. */
export const billingAlertsSentTable = pgTable("billing_alerts_sent", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  cycleAnchor: text("cycle_anchor").notNull(),
  alertType: text("alert_type").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BillingAlertSent = typeof billingAlertsSentTable.$inferSelect;
export type FeeLineItem = typeof feeLineItemsTable.$inferSelect;
export type OriginCorrection = typeof originCorrectionsTable.$inferSelect;
