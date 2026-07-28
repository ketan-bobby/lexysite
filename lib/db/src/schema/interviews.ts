/**
 * schema/interviews.ts — Interview Plans, Sessions & Schedule Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   interview_plans       — Template per job: interview type, question bank,
 *                           scoring rubric. One plan per job; shared across sessions.
 *   interview_sessions    — One session per candidate interview attempt. Stores
 *                           the signed token, transcript, AI scores (communication,
 *                           technical, cultural), and proctoring signals.
 *   interview_schedules   — Calendar-based scheduling records for live (human)
 *                           interviews: scheduled time, location, status.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   interview_type            — general · behavioral · technical · cultural · programming
 *   interview_session_status  — scheduled · in_progress · completed · abandoned · expired
 *   interview_schedule_status — pending · confirmed · cancelled · no_show · completed
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/interviews.ts             — all interview lifecycle routes
 *   lib/agents/interview-reply.ts    — creates sessions on positive reply
 */
import { pgTable, text, timestamp, integer, real, jsonb, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const interviewTypeEnum = pgEnum("interview_type", [
  "technical",
  "behavioral",
  "cultural",
  "competency",
  "general",
  "programming",
]);

/* Full interview-session state machine.
 *   invited    → link sent, never opened
 *   opened     → candidate clicked link (cookie issued)
 *   verified   → step-up OTP cleared (high-trust binding)
 *   active     → answering questions
 *   paused     → user idle / disconnected, expected to resume
 *   resumed    → reopened on a new tab/session within TTL
 *   completed  → finished cleanly
 *   abandoned  → manually marked or detected idle past threshold
 *   expired    → past expiresAt without completion
 *   flagged    → high suspicion, awaits recruiter triage
 *   reviewed   → recruiter signed off on the integrity verdict
 *
 * Legacy values "scheduled" and "in_progress" are kept so existing rows
 * remain valid (drizzle-kit non-destructive enum extension).
 */
export const interviewSessionStatusEnum = pgEnum("interview_session_status", [
  "scheduled",
  "in_progress",
  "completed",
  "abandoned",
  "invited",
  "opened",
  "verified",
  "active",
  "paused",
  "resumed",
  "expired",
  "flagged",
  "reviewed",
]);

/* Severity bucket for an entry in `trust_events` — used by the recruiter
 * integrity view to colour-code and to decide whether a session should be
 * automatically flipped to status="flagged". */
export const trustEventSeverityEnum = pgEnum("trust_event_severity", [
  "info", "low", "medium", "high", "critical",
]);

export const interviewScheduleStatusEnum = pgEnum("interview_schedule_status", [
  "pending",
  "confirmed",
  "rescheduled",
  "cancelled",
  "completed",
  "no_show",
]);

export const interviewPlansTable = pgTable("interview_plans", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  title: text("title").notNull(),
  interviewType: interviewTypeEnum("interview_type").notNull().default("general"),
  language: text("language").notNull().default("en"),
  questions: jsonb("questions").notNull().default([]),
  culturalConfig: jsonb("cultural_config").default(null),
  /* Recruiter's free-form direction for what this interview should focus on
     (e.g. "assess the candidate's ability to build rapport with clients").
     Interpreted as a job-relevant competency and injected into question
     generation, the live interviewer agent, per-answer grading, and the final
     summary. Nullable — set only when the recruiter provides direction. */
  focusDirective: text("focus_directive"),
  estimatedDurationMinutes: integer("estimated_duration_minutes").notNull().default(30),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const interviewSessionsTable = pgTable("interview_sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  applicationId: text("application_id").notNull(),
  planId: text("plan_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  language: text("language").notNull().default("en"),
  status: interviewSessionStatusEnum("status").notNull().default("scheduled"),
  currentQuestionIndex: integer("current_question_index").notNull().default(0),
  totalQuestions: integer("total_questions").notNull().default(0),
  score: real("score"),
  answers: jsonb("answers").notNull().default([]),
  codeSubmissions: jsonb("code_submissions").notNull().default([]),
  proctoring_events: jsonb("proctoring_events").notNull().default([]),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  recordingUrl: text("recording_url"),
  /* 24h interview-invite tracking (used to email candidate a unique link
   * after they reply "interested" to outreach). When the link is opened,
   * inviteOpenedAt is set. If still null after 24h, a re-engagement email
   * is sent and reEngagementSentAt is set so we don't keep nagging. */
  inviteToken:           text("invite_token"),
  inviteSentAt:          timestamp("invite_sent_at"),
  inviteExpiresAt:       timestamp("invite_expires_at"),
  inviteOpenedAt:        timestamp("invite_opened_at"),
  reEngagementSentAt:    timestamp("re_engagement_sent_at"),
  /* Secure resumable session binding — set on first /begin and used by the
   * cookie middleware to authenticate every subsequent candidate request.
   *   bind_secret              random per-session HMAC key (hex)
   *   bind_user_agent          UA captured at first open (soft check)
   *   bind_fingerprint         sha256(UA + Accept-Language + sec-ch-ua) hex
   *   bind_ip_prefix           coarse /24 (v4) or /48 (v6) — logged only,
   *                            never enforced (per spec: do not hard-lock IP)
   *   cookie_nonce             rotates on every step-up to invalidate stale
   *                            cookies and prevent simultaneous active sessions
   *   expires_at               first /begin + INTERVIEW_SESSION_TTL_HOURS (24h)
   *   step_up_required         true after fingerprint mismatch; routes return
   *                            401 {stepUp:true} until OTP is verified
   *   step_up_otp_hash         sha256 hash of issued 6-digit OTP
   *   step_up_otp_expires_at   10-minute OTP validity window
   *   step_up_attempts         brute-force counter; locks at 5
   *   suspicious_events        append-only audit trail of takeover attempts */
  bindSecret:            text("bind_secret"),
  bindUserAgent:         text("bind_user_agent"),
  bindFingerprint:       text("bind_fingerprint"),
  bindIpPrefix:          text("bind_ip_prefix"),
  cookieNonce:           text("cookie_nonce"),
  expiresAt:             timestamp("expires_at"),
  stepUpRequired:        boolean("step_up_required").notNull().default(false),
  stepUpOtpHash:         text("step_up_otp_hash"),
  stepUpOtpExpiresAt:    timestamp("step_up_otp_expires_at"),
  stepUpAttempts:        integer("step_up_attempts").notNull().default(0),
  suspiciousEvents:      jsonb("suspicious_events").notNull().default([]),
  /* ─── Enterprise integrity fields (spec §12) ────────────────────────────
   * Persisted state-machine timestamps + per-session integrity counters so
   * the recruiter integrity view can render without re-aggregating event
   * logs on every load.
   *
   *   claimedAt              : first /begin (cookie issued)
   *   openedAt               : same as claimedAt unless the session was
   *                            invited but never claimed
   *   verifiedAt             : last successful step-up OTP verification
   *   pausedAt/resumedAt     : last pause/resume transition
   *   abandonedAt/expiredAt  : terminal states
   *   flaggedAt/reviewedAt   : recruiter-integrity workflow markers
   *   lastActiveAt           : touched on every authenticated request
   *   trustScore             : 0..100; starts at 100, drops on risk signals
   *   resumeCount            : how many distinct /begin reopens
   *   suspiciousEventCount   : denormalised counter of trust_events rows
   *   activeConnectionId     : opaque per-claim connection token; new value
   *                            on each successful /begin so a previously
   *                            attached websocket can detect it has been
   *                            superseded by a new active session
   *   verificationRequired   : mirror of stepUpRequired exposed to client
   *                            APIs as a stable name (spec field)
   */
  claimedAt:             timestamp("claimed_at"),
  openedAt:              timestamp("opened_at"),
  verifiedAt:            timestamp("verified_at"),
  pausedAt:              timestamp("paused_at"),
  resumedAt:             timestamp("resumed_at"),
  abandonedAt:           timestamp("abandoned_at"),
  expiredAt:             timestamp("expired_at"),
  flaggedAt:             timestamp("flagged_at"),
  reviewedAt:            timestamp("reviewed_at"),
  lastActiveAt:          timestamp("last_active_at"),
  trustScore:            integer("trust_score").notNull().default(100),
  resumeCount:           integer("resume_count").notNull().default(0),
  suspiciousEventCount:  integer("suspicious_event_count").notNull().default(0),
  activeConnectionId:    text("active_connection_id"),
  verificationRequired:  boolean("verification_required").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* trust_events — normalised audit log of every integrity-relevant event in
 * an interview session. One row per event so recruiters can sort/filter and
 * we can run cross-session analytics ("how often does this candidate trip
 * device-mismatch across multiple interviews?"). The denormalised counters
 * on interview_sessions stay in sync via recordTrustEvent() in
 * lib/interview-session-cookie.ts.
 *
 * Severity drives both UI badge colour and the auto-flag rule
 * (severity="critical" → status flips to "flagged" + flaggedAt set).
 */
export const trustEventsTable = pgTable("trust_events", {
  id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId:     text("tenant_id").notNull(),
  sessionId:    text("session_id").notNull(),
  candidateId:  text("candidate_id"),
  eventType:    text("event_type").notNull(),
  severity:     trustEventSeverityEnum("severity").notNull().default("info"),
  scoreImpact:  integer("score_impact").notNull().default(0),
  metadata:     jsonb("metadata").notNull().default({}),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
});

export const insertTrustEventSchema = createInsertSchema(trustEventsTable).omit({ id: true, createdAt: true });
export type InsertTrustEvent = z.infer<typeof insertTrustEventSchema>;
export type TrustEvent = typeof trustEventsTable.$inferSelect;

export const interviewSummariesTable = pgTable("interview_summaries", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  interviewSessionId: text("interview_session_id").notNull().unique(),
  overallScore: real("overall_score").notNull(),
  strengths: text("strengths").array().notNull().default([]),
  weaknesses: text("weaknesses").array().notNull().default([]),
  redFlags: text("red_flags").array().notNull().default([]),
  recommendation: text("recommendation").notNull().default("maybe"),
  recruiterSummary: text("recruiter_summary").notNull(),
  /* Free-text notes the recruiter adds on the interview detail page. Surfaced in
     the client-shareable interview performance PDF. Nullable — set only when the
     recruiter chooses to annotate the AI assessment. */
  recruiterComments: text("recruiter_comments"),
  transcript: jsonb("transcript").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const interviewSchedulesTable = pgTable("interview_schedules", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  applicationId: text("application_id").notNull(),
  interviewerId: text("interviewer_id"),
  interviewerName: text("interviewer_name"),
  location: text("location"),
  scheduledAt: timestamp("scheduled_at").notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  type: text("type").notNull(),
  status: interviewScheduleStatusEnum("status").notNull().default("pending"),
  notes: text("notes"),
  feedbackRating: integer("feedback_rating"),
  feedbackNotes: text("feedback_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertInterviewPlanSchema = createInsertSchema(interviewPlansTable).omit({ id: true, createdAt: true });
export type InsertInterviewPlan = z.infer<typeof insertInterviewPlanSchema>;
export type InterviewPlan = typeof interviewPlansTable.$inferSelect;

export const insertInterviewSessionSchema = createInsertSchema(interviewSessionsTable).omit({ id: true, createdAt: true });
export type InsertInterviewSession = z.infer<typeof insertInterviewSessionSchema>;
export type InterviewSession = typeof interviewSessionsTable.$inferSelect;
