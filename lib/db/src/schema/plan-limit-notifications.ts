/**
 * schema/plan-limit-notifications.ts — Plan-Limit-Hit Email Idempotency Ledger
 *
 * One row per (tenant, limit kind, period) the moment a "you've hit your plan
 * limit" email is sent. The unique constraint on (tenant_id, kind, period_key)
 * combined with `INSERT … ON CONFLICT DO NOTHING` gives us atomic, cheap
 * "send at most once per period" semantics — the writer that successfully
 * inserts the row owns the send; everyone else no-ops.
 *
 * Why a dedicated table (not columns on tenants like trial_*_sent_at)?
 *   - The kinds are open-ended (jobs, interviews, seats, sub-clients, credit
 *     kinds, plus future ones) — adding a column per kind per period would
 *     bloat the tenants row.
 *   - period_key varies per kind: monthly meters get "YYYY-MM"; lifetime
 *     gates (seats, sub-clients, demo) get "lifetime". This naturally lives
 *     in a row, not a fixed column.
 *
 * `kind` is text (not an enum) so adding a new gated limit doesn't require
 * a migration; the universe of valid kinds is owned by lib/plan-enforcement.ts
 * via the LimitKind union.
 */
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const planLimitNotificationsTable = pgTable("plan_limit_notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  /** Free-text limit identifier — e.g. "open_jobs", "interviews",
   *  "staff_seats", "sub_clients", or a credit kind. Defined in
   *  lib/plan-enforcement.ts (LimitKind). */
  kind: text("kind").notNull(),
  /** Either a calendar-month key "YYYY-MM" (monthly limits) or "lifetime"
   *  (one-shot limits like seats / sub-clients / demo). The unique index
   *  guarantees at most one email per (tenant, kind, period). */
  periodKey: text("period_key").notNull(),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
}, (t) => ({
  tenantKindPeriodUq: uniqueIndex("plan_limit_notifications_tenant_kind_period_uq")
    .on(t.tenantId, t.kind, t.periodKey),
}));

export type PlanLimitNotification = typeof planLimitNotificationsTable.$inferSelect;
