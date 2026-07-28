/**
 * schema/icp.ts — Ideal Candidate Profile (ICP) Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   ideal_candidate_profiles   — One ICP per job. Stores the AI-extracted or
 *                                recruiter-defined profile: required/nice-to-have
 *                                skills, experience range, location preferences,
 *                                work style, and the raw JD text used for generation.
 *                                Used as the primary scoring rubric for all AI agents.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/icp.ts           — CRUD API
 *   lib/intelligence.ts     — reads ICP for scoring
 *   lib/agents/orchestrator.ts — icp agent writes here
 */
import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const icpTable = pgTable("ideal_candidate_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  version: integer("version").notNull().default(1),
  jobTitle: text("job_title").notNull(),
  roleFamily: text("role_family"),
  seniority: text("seniority"),
  requiredSkills: text("required_skills").array().notNull().default([]),
  preferredSkills: text("preferred_skills").array().notNull().default([]),
  yearsExperienceMin: integer("years_experience_min"),
  yearsExperienceMax: integer("years_experience_max"),
  industryBackground: text("industry_background").array().notNull().default([]),
  educationRequirements: text("education_requirements"),
  mustHaves: text("must_haves").array().notNull().default([]),
  niceToHaves: text("nice_to_haves").array().notNull().default([]),
  disqualifiers: text("disqualifiers").array().notNull().default([]),
  expandedSkillGraph: jsonb("expanded_skill_graph").notNull().default({}),
  weightedAttributes: jsonb("weighted_attributes").notNull().default({}),
  // ── Domain / sourcing extensions (added 2026-05) ───────────────────────
  // All nullable so legacy ICP rows keep working unchanged.
  domain: text("domain"),                                                            // "Healthcare", "Finance", "Software", "Legal", etc.
  subSpecialty: text("sub_specialty"),                                               // e.g. "Outpatient Clinical Informatics"
  alternateTitles: text("alternate_titles").array().notNull().default([]),           // synonyms / equivalent titles
  requiredCertifications: text("required_certifications").array().notNull().default([]),
  toolsAndSystems: text("tools_and_systems").array().notNull().default([]),          // Epic, Cerner, Salesforce, AWS, etc.
  compliance: text("compliance").array().notNull().default([]),                       // HIPAA, SOC2, PCI, FDA, etc.
  negativeKeywords: text("negative_keywords").array().notNull().default([]),         // exclude these terms when sourcing
  booleanSearchString: text("boolean_search_string"),                                // recruiter-style boolean string
  location: text("location"),                                                         // target location/region for sourcing (e.g. "Telangana, India"); nullable, inherited from job.location at generation
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertIcpSchema = createInsertSchema(icpTable).omit({ id: true, createdAt: true });
export type InsertIcp = z.infer<typeof insertIcpSchema>;
export type Icp = typeof icpTable.$inferSelect;
