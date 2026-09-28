import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type CandidateLearningInterests = {
  careerAreas: string[];
  otherInterest: string | null;
  immediateRoles: string[];
  educationStage: string;
  discipline: string | null;
  graduationYear: number | null;
  learningPriorities: string[];
  preferredLanguage: string | null;
  accessibilityPreferences: string | null;
  startTiming: string;
};

/**
 * Candidate-private graduate learning pilot state.
 *
 * Career goals remain canonical in candidate_career_profiles. The goal fields
 * here are the candidate's confirmation snapshot, used only to detect when a
 * later canonical profile edit invalidates that confirmation.
 */
export const candidateLearningProfilesTable = pgTable("candidate_learning_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  interests: jsonb("interests").$type<CandidateLearningInterests>(),
  immediateGoal: text("immediate_goal"),
  confirmedCareerGoal3yr: text("confirmed_career_goal_3yr"),
  confirmedCareerGoal5yr: text("confirmed_career_goal_5yr"),
  goalsConfirmedAt: timestamp("goals_confirmed_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CandidateLearningProfile = typeof candidateLearningProfilesTable.$inferSelect;