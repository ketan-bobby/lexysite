-- Rollback for 0011 — candidate work-auth + voluntary self-ID demographics.
-- Drops the new table first, then strips the candidate columns. Safe to run
-- against a freshly migrated DB.

DROP INDEX IF EXISTS candidate_demographics_candidate_uq;
DROP TABLE IF EXISTS candidate_demographics;

ALTER TABLE candidates
  DROP COLUMN IF EXISTS screening_completed_at,
  DROP COLUMN IF EXISTS sponsorship_notes,
  DROP COLUMN IF EXISTS sponsorship_country,
  DROP COLUMN IF EXISTS requires_sponsorship,
  DROP COLUMN IF EXISTS work_authorized;
