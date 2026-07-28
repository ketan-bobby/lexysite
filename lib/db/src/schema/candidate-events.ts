/**
 * schema/candidate-events.ts — Candidate Lifecycle Event Log
 *
 * ─── Tables ───────────────────────────────────────────────────────────────────
 *   candidate_events  — Immutable audit log of every meaningful hiring action.
 *                       One row per event; metadata_json carries structured
 *                       context (amounts, reasons, scores, etc.).
 *
 * ─── actor_type values ───────────────────────────────────────────────────────
 *   candidate | recruiter | hiring_manager | admin | system | integration
 *
 * ─── source values ───────────────────────────────────────────────────────────
 *   lexy_app | email | sms | calendar | interview_agent |
 *   recruiter_action | admin_action | future_integration
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/candidate-event-logger.ts — Shared write helper (all routes import this)
 *   routes/candidate-events.ts    — Public API endpoints
 *   routes/outcomes.ts            — Offer/hire funnel events
 */
import { pgTable, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const candidateEventTypeEnum = pgEnum("candidate_event_type", [
  "CANDIDATE_CREATED",
  "JOB_MATCHED",
  "OUTREACH_SENT",
  "OUTREACH_OPENED",
  "OUTREACH_REPLIED",
  "INTERVIEW_INVITED",
  "INTERVIEW_STARTED",
  "INTERVIEW_COMPLETED",
  "INTERVIEW_SCORE_GENERATED",
  "RECRUITER_REVIEWED",
  "RECRUITER_SHORTLISTED",
  "SUBMITTED_TO_HIRING_MANAGER",
  "HIRING_MANAGER_INTERVIEW_SCHEDULED",
  "HIRING_MANAGER_INTERVIEW_COMPLETED",
  "OFFER_RECOMMENDED",
  "OFFER_EXTENDED",
  "OFFER_ACCEPTED",
  "OFFER_DECLINED",
  "HIRED",
  "STARTED",
  "REJECTED",
  "WITHDRAWN",
  // ── Generic pipeline transition (ticket 4d) — every move, incl. non-milestone
  //    and backward moves; written only via lib/change-candidate-stage.ts ──
  "STAGE_CHANGED",
  "ROLE_OUTCOME_REPORTED",
  // ── Recruiter intro video (HeyGen) — Phase 1 ──
  "INTRO_VIDEO_GENERATED",
  "INTRO_VIDEO_GENERATION_FAILED",
  "INTRO_VIDEO_STARTED",
  "INTRO_VIDEO_COMPLETED",
  "INTRO_VIDEO_SKIPPED",
]);

export type CandidateEventType = (typeof candidateEventTypeEnum.enumValues)[number];

export const candidateEventsTable = pgTable("candidate_events", {
  eventId:       text("event_id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId:   text("candidate_id").notNull(),
  jobId:         text("job_id").notNull(),
  tenantId:      text("tenant_id").notNull(),
  applicationId: text("application_id"),
  eventType:     candidateEventTypeEnum("event_type").notNull(),
  eventTimestamp: timestamp("event_timestamp", { withTimezone: true }).notNull().defaultNow(),
  actorType:     text("actor_type"),
  actorId:       text("actor_id"),
  source:        text("source").notNull().default("lexy_app"),
  metadataJson:  jsonb("metadata_json"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
});

export const insertCandidateEventSchema = createInsertSchema(candidateEventsTable).omit({ eventId: true, createdAt: true });
export const selectCandidateEventSchema = createSelectSchema(candidateEventsTable);
export type InsertCandidateEvent = z.infer<typeof insertCandidateEventSchema>;
export type CandidateEvent = typeof candidateEventsTable.$inferSelect;
