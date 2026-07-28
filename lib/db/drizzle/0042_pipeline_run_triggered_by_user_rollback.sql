-- 0042_pipeline_run_triggered_by_user_rollback.sql
-- Reverses 0042_pipeline_run_triggered_by_user.sql.

ALTER TABLE public.pipeline_runs
  DROP COLUMN IF EXISTS triggered_by_user_id;
