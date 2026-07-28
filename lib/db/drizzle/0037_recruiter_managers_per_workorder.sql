-- 0037_recruiter_managers_per_workorder.sql
-- Add per-work-order scoping to recruiter → recruiter-admin reporting links.
--
-- A NULL job_id row is the recruiter's DEFAULT reporting (unchanged behaviour).
-- A row with job_id set is a per-work-order OVERRIDE (jobs.id), so reporting can
-- differ for each individual work order. RLS (tenant_isolation on tenant_id) is
-- unchanged — the new column does not affect row scoping.

ALTER TABLE recruiter_managers
  ADD COLUMN IF NOT EXISTS job_id text;

-- Replace the (recruiter, admin) unique index with one that also keys on the
-- work order. COALESCE(job_id,'') keeps NULL (default) rows de-duplicated too,
-- since Postgres treats NULLs as distinct in a plain unique index.
DROP INDEX IF EXISTS recruiter_managers_uniq;
CREATE UNIQUE INDEX recruiter_managers_uniq
  ON recruiter_managers (recruiter_user_id, recruiter_admin_user_id, COALESCE(job_id, ''));

CREATE INDEX IF NOT EXISTS recruiter_managers_job_idx
  ON recruiter_managers (job_id);
