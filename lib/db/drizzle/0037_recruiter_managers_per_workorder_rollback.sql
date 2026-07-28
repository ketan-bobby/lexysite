-- Rollback 0037_recruiter_managers_per_workorder.sql
-- Drops the per-work-order override rows and column, restoring the flat
-- (recruiter, admin) unique link.

-- Remove per-work-order override rows before dropping the column so the
-- restored unique index cannot collide on duplicate (recruiter, admin) pairs.
DELETE FROM recruiter_managers WHERE job_id IS NOT NULL;

DROP INDEX IF EXISTS recruiter_managers_job_idx;
DROP INDEX IF EXISTS recruiter_managers_uniq;

ALTER TABLE recruiter_managers
  DROP COLUMN IF EXISTS job_id;

CREATE UNIQUE INDEX recruiter_managers_uniq
  ON recruiter_managers (recruiter_user_id, recruiter_admin_user_id);
