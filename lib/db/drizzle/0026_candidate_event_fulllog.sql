-- Migration 0026: Candidate Event Full Logging
-- Expands candidate_events with actor/source columns and 17 new event types

-- ── Expand the enum ───────────────────────────────────────────────────────────
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'CANDIDATE_CREATED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'JOB_MATCHED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'OUTREACH_SENT';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'OUTREACH_OPENED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'OUTREACH_REPLIED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'INTERVIEW_INVITED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'INTERVIEW_STARTED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'INTERVIEW_COMPLETED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'INTERVIEW_SCORE_GENERATED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'RECRUITER_REVIEWED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'RECRUITER_SHORTLISTED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'SUBMITTED_TO_HIRING_MANAGER';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'HIRING_MANAGER_INTERVIEW_SCHEDULED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'HIRING_MANAGER_INTERVIEW_COMPLETED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'OFFER_RECOMMENDED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'WITHDRAWN';

-- ── Add new columns ───────────────────────────────────────────────────────────
ALTER TABLE candidate_events ADD COLUMN IF NOT EXISTS application_id TEXT;
ALTER TABLE candidate_events ADD COLUMN IF NOT EXISTS actor_type    TEXT;
ALTER TABLE candidate_events ADD COLUMN IF NOT EXISTS actor_id      TEXT;
ALTER TABLE candidate_events ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'lexy_app';

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS candidate_events_application_id_idx  ON candidate_events (application_id);
CREATE INDEX IF NOT EXISTS candidate_events_tenant_job_idx      ON candidate_events (tenant_id, job_id);
CREATE INDEX IF NOT EXISTS candidate_events_tenant_cand_idx     ON candidate_events (tenant_id, candidate_id);
