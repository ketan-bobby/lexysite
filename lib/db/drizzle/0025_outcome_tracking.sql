-- migration 0025 — Outcome Tracking Phase 1
--
-- 1. Extend the application_stage enum with offer/post-offer stages.
-- 2. Create candidate_outcomes table (one row per offer-track application).
-- 3. Create candidate_event_type enum + candidate_events audit log.
--
-- NOTE: ALTER TYPE … ADD VALUE cannot run inside a transaction block in
-- Postgres < 12. Drizzle runs migrations outside explicit transactions by
-- default, so these statements are safe.

ALTER TYPE "application_stage" ADD VALUE IF NOT EXISTS 'offer_recommended' AFTER 'hm_review';
ALTER TYPE "application_stage" ADD VALUE IF NOT EXISTS 'offer_extended'    AFTER 'offer_recommended';
ALTER TYPE "application_stage" ADD VALUE IF NOT EXISTS 'offer_accepted'    AFTER 'offer_extended';
ALTER TYPE "application_stage" ADD VALUE IF NOT EXISTS 'offer_declined'    AFTER 'offer_accepted';
ALTER TYPE "application_stage" ADD VALUE IF NOT EXISTS 'started'           AFTER 'hired';

-- candidate_outcomes: one row per application that enters the offer funnel.
CREATE TABLE IF NOT EXISTS "candidate_outcomes" (
  "id"               text PRIMARY KEY,
  "tenant_id"        text NOT NULL,
  "application_id"   text NOT NULL,
  "candidate_id"     text NOT NULL,
  "job_id"           text NOT NULL,
  "offer_date"       timestamptz,
  "offer_amount"     real,
  "offer_accepted"   boolean,
  "offer_accept_date" timestamptz,
  "hire_date"        timestamptz,
  "start_date"       timestamptz,
  "decline_reason"   text,
  "outcome_source"   text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "candidate_outcomes_application_id_idx" ON "candidate_outcomes" ("application_id");
CREATE INDEX IF NOT EXISTS "candidate_outcomes_tenant_id_idx"      ON "candidate_outcomes" ("tenant_id");
CREATE INDEX IF NOT EXISTS "candidate_outcomes_candidate_id_idx"   ON "candidate_outcomes" ("candidate_id");

-- candidate_event_type enum + candidate_events audit log.
DO $$ BEGIN
  CREATE TYPE "candidate_event_type" AS ENUM (
    'OFFER_EXTENDED', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'HIRED', 'STARTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "candidate_events" (
  "event_id"         text PRIMARY KEY,
  "candidate_id"     text NOT NULL,
  "job_id"           text NOT NULL,
  "tenant_id"        text NOT NULL,
  "event_type"       candidate_event_type NOT NULL,
  "event_timestamp"  timestamptz NOT NULL DEFAULT now(),
  "metadata_json"    jsonb,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "candidate_events_candidate_id_idx"    ON "candidate_events" ("candidate_id");
CREATE INDEX IF NOT EXISTS "candidate_events_job_id_idx"          ON "candidate_events" ("job_id");
CREATE INDEX IF NOT EXISTS "candidate_events_tenant_id_idx"       ON "candidate_events" ("tenant_id");
CREATE INDEX IF NOT EXISTS "candidate_events_event_timestamp_idx" ON "candidate_events" ("event_timestamp");
