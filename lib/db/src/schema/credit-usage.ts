/**
 * schema/credit-usage.ts — Metered Resource Usage (Credits)
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Plan limits in lib/plans.ts (e.g. maxInterviewsPerMonth, maxCandidateDbSearchesPerMonth)
 * historically were enforced by counting rows in their feature table (interview
 * sessions, etc.). That works for resources that already have their own table,
 * but does NOT work for ephemeral metered actions that don't leave a row
 * behind — AI generations, outreach sends, search queries, etc.
 *
 * `credit_usage_events` is a single ledger of every metered action. Each row
 * is one consumed unit. We sum/group by (tenant_id, kind, period) to compute
 * usage against plan limits and to drive the in-app meter UI.
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   credit_usage_events — one row per metered action (immutable ledger)
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   credit_kind — interview · candidate_db_search · ai_generation · outreach_message
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/plan-enforcement.ts   — recordCreditEvent + getCreditUsage
 *   routes/credits.ts          — GET /credits/me/usage tenant breakdown
 *   routes/plans.ts            — usage payload exposed to the Subscription UI
 */
import { pgTable, text, timestamp, integer, pgEnum, jsonb } from "drizzle-orm/pg-core";

export const creditKindEnum = pgEnum("credit_kind", [
  "interview",
  "candidate_db_search",
  "ai_generation",
  "outreach_message",
]);

export const creditUsageEventsTable = pgTable("credit_usage_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id"),
  kind: creditKindEnum("kind").notNull(),
  /** Number of credits consumed by this single action (default 1). */
  units: integer("units").notNull().default(1),
  /** Optional reference to the resource this credit relates to (interview id,
   *  search query id, etc.) — useful for audit, not used for enforcement. */
  refId: text("ref_id"),
  /** Free-form context (e.g. JD title, search keywords). Plain JSON. */
  metadata: jsonb("metadata"),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
});

export type CreditUsageEvent = typeof creditUsageEventsTable.$inferSelect;
export type InsertCreditUsageEvent = typeof creditUsageEventsTable.$inferInsert;
