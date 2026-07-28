/**
 * schema/verify.ts — Candidate Verification Records Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   verification_records   — One row per candidate (candidateId is UNIQUE)
 *                            holding the Verification Agent's output: a risk
 *                            score, identity/duplicate/resume-consistency
 *                            signals, a flags array, and reviewer notes.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/verify.ts       — run/read candidate verification
 *   lib/run-verification.ts — populates risk score, flags, and verdict
 */
import { pgTable, text, timestamp, real, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const verificationRecordsTable = pgTable("verification_records", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull().unique(),
  status: text("status").notNull().default("unverified"),
  riskScore: real("risk_score").notNull().default(0),
  flags: jsonb("flags").notNull().default([]),
  identityVerified: boolean("identity_verified").notNull().default(false),
  duplicateDetected: boolean("duplicate_detected").notNull().default(false),
  resumeConsistencyScore: real("resume_consistency_score"),
  reviewedAt: timestamp("reviewed_at"),
  reviewNotes: text("review_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertVerificationSchema = createInsertSchema(verificationRecordsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertVerification = z.infer<typeof insertVerificationSchema>;
export type VerificationRecord = typeof verificationRecordsTable.$inferSelect;
