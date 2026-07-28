/**
 * schema/disclosure-acks.ts — candidate_disclosure_acks (Migration 0017)
 *
 * Append-only proof-of-notice rows. One row per (candidate, surface,
 * acknowledged_at). The UI never edits or deletes them; the table has
 * DB triggers that block both operations. See migration 0017 for the
 * legal rationale (LL144 § 5-301, IL AIVI, EU AI Act).
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const candidateDisclosureAcksTable = pgTable("candidate_disclosure_acks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  applicationId: text("application_id"),
  jurisdictionCodes: text("jurisdiction_codes").array().notNull().default(sql`'{}'::text[]`),
  disclosureTemplateIds: text("disclosure_template_ids").array().notNull().default(sql`'{}'::text[]`),
  policyVersionIds: text("policy_version_ids").array().notNull().default(sql`'{}'::text[]`),
  surface: text("surface"),
  /* Server-side idempotency key (Migration 0018). Deterministic hash
   * of candidate_id + surface + sorted template_ids + sorted
   * policy_version_ids. Unique partial index in 0018 means a retry
   * of the same conceptual ack becomes a no-op at the DB level
   * regardless of client-side suppression. */
  ackKey: text("ack_key"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCandidateDisclosureAckSchema = createInsertSchema(candidateDisclosureAcksTable).omit({ id: true, createdAt: true });
export type CandidateDisclosureAck = typeof candidateDisclosureAcksTable.$inferSelect;
