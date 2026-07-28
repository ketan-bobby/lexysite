/**
 * schema/career_progress.ts — Candidate Career Progress & Activity Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_progress_snapshots  — Periodic snapshots of a candidate's career
 *                                   health score, profile completeness, and
 *                                   activity level. Used for trend charts in portal.
 *   candidate_activity_streaks    — Tracks consecutive active days / weeks so the
 *                                   portal can display an "activity streak" badge.
 *   candidate_action_events       — Raw action log (profile update, interview
 *                                   completed, application submitted, etc.) that
 *                                   drives both the streak and the progress snapshot.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/career-profile.ts   — progress summary and action recording
 */
import { pgTable, text, timestamp, integer, boolean, jsonb, real, primaryKey } from "drizzle-orm/pg-core";

export const candidateProgressSnapshotsTable = pgTable("candidate_progress_snapshots", {
  id:                  text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId:         text("candidate_id").notNull(),
  readinessScore:      integer("readiness_score").notNull().default(0),
  profileCompleteness: integer("profile_completeness").notNull().default(0),
  opportunitiesCount:  integer("opportunities_count").notNull().default(0),
  visibilityScore:     integer("visibility_score").notNull().default(0),
  recruiterViews:      integer("recruiter_views").notNull().default(0),
  /* Peer percentile + fuzzy positive band (country & global) — populated by
     the peer-percentile scheduler. Bands are intentionally fuzzy ("Top quarter",
     "Above average", "Building momentum") so candidates always see encouragement. */
  peerPctCountry:      integer("peer_pct_country"),
  peerPctGlobal:       integer("peer_pct_global"),
  peerBandCountry:     text("peer_band_country"),
  peerBandGlobal:      text("peer_band_global"),
  country:             text("country"),
  peerUpdatedAt:       timestamp("peer_updated_at"),
  createdAt:           timestamp("created_at").notNull().defaultNow(),
});

export const candidateActivityStreaksTable = pgTable("candidate_activity_streaks", {
  id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId:      text("candidate_id").notNull().unique(),
  currentStreak:    integer("current_streak").notNull().default(0),
  longestStreak:    integer("longest_streak").notNull().default(0),
  totalSessions:    integer("total_sessions").notNull().default(0),
  lastActivityAt:   timestamp("last_activity_at"),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
});

export const candidateActionEventsTable = pgTable("candidate_action_events", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  eventType:   text("event_type").notNull(),
  /* For eventType='recruiter_view', the tenantId of the viewing recruiter.
     Denormalized so we can cheaply answer "top viewer companies, last 30d"
     and "did target company X view me?" without parsing JSON. NULL for
     event types that aren't recruiter views, or for legacy rows. */
  viewerTenantId: text("viewer_tenant_id"),
  payload:     jsonb("payload").$type<Record<string, any>>().default({}),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

/* Throttle table for the market-event emitter — one row per
   (candidate, eventKey). Prevents duplicate "Stripe just viewed you" /
   "Your market value moved" emails within the cooldown window. */
export const candidateMarketEventsSentTable = pgTable("candidate_market_events_sent", {
  candidateId: text("candidate_id").notNull(),
  eventKey:    text("event_key").notNull(),
  sentAt:      timestamp("sent_at").notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.candidateId, t.eventKey], name: "candidate_market_events_sent_pkey" }),
}));

export type CandidateProgressSnapshot   = typeof candidateProgressSnapshotsTable.$inferSelect;
export type CandidateActivityStreak     = typeof candidateActivityStreaksTable.$inferSelect;
export type CandidateActionEvent        = typeof candidateActionEventsTable.$inferSelect;
export type CandidateMarketEventSent    = typeof candidateMarketEventsSentTable.$inferSelect;
