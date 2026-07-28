/**
 * schema/sourcing.ts — External Candidate Sourcing & Platform Pool Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   sourced_candidates   — Candidates discovered via external sourcing (GitHub,
 *                          PDL, SERP) or submitted by recruiters for a job. Stores
 *                          the raw profile snapshot, ICP match score, pipeline stage,
 *                          and the source channel. Separate from the core candidates
 *                          table until the candidate creates a portal account.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   candidate_source — github · pdl · serp · manual · platform · talent_pool
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/agents/orchestrator.ts  — sourcing agent writes here
 *   routes/pipeline.ts          — Kanban board reads sourced_candidates
 *   lib/outreach-engine.ts      — enrolls sourced candidates in campaigns
 */
import { pgTable, text, timestamp, real, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const sourceEnum = pgEnum("candidate_source", [
  "pdl",
  "serp",
  "github",
  "linkedin",
  "internal",
  "manual",
  "referral",
]);

export const sourcedCandidatesTable = pgTable("sourced_candidates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  source: sourceEnum("source").notNull(),
  rawData: jsonb("raw_data").notNull().default({}),
  normalizedCandidateId: text("normalized_candidate_id"),
  mergeConfidence: real("merge_confidence"),
  mergedWithCandidateId: text("merged_with_candidate_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSourcedCandidateSchema = createInsertSchema(sourcedCandidatesTable).omit({ id: true, createdAt: true });
export type InsertSourcedCandidate = z.infer<typeof insertSourcedCandidateSchema>;
export type SourcedCandidate = typeof sourcedCandidatesTable.$inferSelect;
