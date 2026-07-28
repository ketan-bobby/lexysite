-- Rollback for 0019_jobs_salary_range_check.sql
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_salary_min_le_max_chk;
