/**
 * schema/talent_pool.ts — Talent Pool Submission Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   talent_pool_submissions   — Records when a platform-pool candidate is pushed
 *                               to a client tenant's talent pool, either by the
 *                               platform-recommendation-engine (auto) or manually
 *                               by a recruiter. Stores the optional recruiter note
 *                               and the push timestamp.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/platform-recommendation-engine.ts   — auto-push on strong match
 *   routes/sourcing.ts                      — manual push endpoint
 *   components/share/PushToClientModal.tsx  — recruiter-initiated push
 */
import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const talentPoolSubmissionsTable = pgTable("talent_pool_submissions", {
  id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fullName:         text("full_name").notNull(),
  email:            text("email").notNull(),
  phone:            text("phone"),
  currentTitle:     text("current_title").notNull(),
  location:         text("location"),
  experienceLevel:  text("experience_level"),
  workStyle:        text("work_style"),
  languages:        jsonb("languages").$type<string[]>().default([]),
  bio:              text("bio"),
  linkedinUrl:      text("linkedin_url"),
  resumeObjectPath: text("resume_object_path"),
  status:           text("status").notNull().default("active"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  // Added: push-to-client fields
  candidateId:      text("candidate_id"),
  clientTenantId:   text("client_tenant_id"),
  pushedByUserId:   text("pushed_by_user_id"),
  note:             text("note"),
  pushedAt:         timestamp("pushed_at"),
  jobPostingId:     text("job_posting_id"),
});
