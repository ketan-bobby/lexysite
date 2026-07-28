-- 0019_jobs_salary_range_check.sql
-- Enforce salary_min <= salary_max at the database level.
-- The API layer already validates this in zod, but a DB CHECK constraint
-- guarantees the invariant against any future direct write, backfill,
-- or migration that bypasses the API.
-- NULLs on either side are allowed (open-ended ranges).

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_salary_min_le_max_chk
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max);
