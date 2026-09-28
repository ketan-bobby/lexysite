/**
 * Candidate-approved introduction fields, deliberately separate from the
 * private career profile and every interview/preparation data source.
 *
 * A row is private until `status === "approved"`. The only employer-safe
 * fields live in this table; no profile, transcript, score, or recording data
 * may be copied here by server code.
 */
import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export type CandidateIntroductionStrength = {
  title: string;
  evidence: string;
};

export type CandidateIntroductionAchievement = {
  text: string;
};

export const candidateIntroductionsTable = pgTable("candidate_introductions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  summary: text("summary").notNull().default(""),
  strengths: jsonb("strengths").$type<CandidateIntroductionStrength[]>().notNull().default([]),
  achievements: jsonb("achievements").$type<CandidateIntroductionAchievement[]>().notNull().default([]),
  careerDirection: text("career_direction"),
  rolePreferences: text("role_preferences"),
  availability: text("availability"),
  /** draft | approved | withdrawn. Editing always returns an approved row to draft. */
  status: text("status").notNull().default("draft"),
  approvedAt: timestamp("approved_at"),
  withdrawnAt: timestamp("withdrawn_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CandidateIntroduction = typeof candidateIntroductionsTable.$inferSelect;