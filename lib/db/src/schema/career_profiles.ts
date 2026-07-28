/**
 * schema/career_profiles.ts — Candidate Career Profile Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_career_profiles   — Extended career data collected through the AI
 *                                 career-baseline interview and portal onboarding:
 *                                 work history, education, skills, preferences,
 *                                 career goals, and interview performance signals.
 *                                 One row per candidate; upserted after each session.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/career-profile.ts   — portal read/write API
 *   lib/intelligence.ts        — enriches intelligence scoring with career data
 */
import { pgTable, text, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";

export const candidateCareerProfilesTable = pgTable("candidate_career_profiles", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull().unique(),

  currentTitle:       text("current_title"),
  currentCompany:     text("current_company"),
  yearsExperience:    integer("years_experience"),
  currentSalaryRange: text("current_salary_range"),
  skills:             text("skills").array().default([]),
  education:          text("education"),
  location:           text("location"),
  bio:                text("bio"),

  careerGoal3yr:     text("career_goal_3yr"),
  careerGoal5yr:     text("career_goal_5yr"),
  targetCompanies:   jsonb("target_companies").$type<string[]>().default([]),
  targetIndustries:  jsonb("target_industries").$type<string[]>().default([]),
  preferredRoles:    jsonb("preferred_roles").$type<string[]>().default([]),
  desiredSalaryRange: text("desired_salary_range"),
  preferredWorkStyle: text("preferred_work_style"),
  preferredTeamSize:  text("preferred_team_size"),
  motivations:        jsonb("motivations").$type<string[]>().default([]),

  baselineInterviewCompleted: boolean("baseline_interview_completed").default(false),
  baselineConversation:       jsonb("baseline_conversation").$type<Array<{ role: string; content: string }>>().default([]),
  recordingUrl:               text("recording_url"),
  recordingDurationSec:       integer("recording_duration_sec"),
  recordingStatus:            text("recording_status"),

  interviewLanguage:       text("interview_language"),
  transcriptEnglish:       text("transcript_english"),
  transcriptNative:        text("transcript_native"),
  analysisEnglish:         text("analysis_english"),
  analysisNative:          text("analysis_native"),

  careerPaths:  jsonb("career_paths").$type<any[]>().default([]),
  aiSummary:    text("ai_summary"),
  strengthAreas: jsonb("strength_areas").$type<string[]>().default([]),
  growthAreas:   jsonb("growth_areas").$type<string[]>().default([]),
  profileCompleteness:   integer("profile_completeness").default(0),
  interviewQualityScore: integer("interview_quality_score").default(100),

  resumeParsedProfile: jsonb("resume_parsed_profile").$type<Record<string, any>>(),
  resumeSignals:       jsonb("resume_signals").$type<Record<string, any>>(),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CandidateCareerProfile = typeof candidateCareerProfilesTable.$inferSelect;
