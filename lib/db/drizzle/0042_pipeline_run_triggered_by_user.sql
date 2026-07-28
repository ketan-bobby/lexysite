-- 0042_pipeline_run_triggered_by_user.sql
-- Add TRIGGERED_BY_USER_ID to pipeline_runs so the run audit trail records WHICH
-- user initiated a run, not just the coarse `triggered_by` label
-- ("user" / "auto" / "orchestrator" / "scheduler"). This is a durable audit
-- requirement: the "who triggered what, when, with what result" story must
-- survive a deploy, and pipeline_runs is the only persistent record of a run.
--
-- Nullable with NO default: existing rows are backfilled to NULL (unknown) — we
-- do not guess a user for historical runs. New runs populate it at insert time
-- from the authenticated caller (see routes/agents.ts, where the id is already
-- resolved via getAuthUserId).
--
-- Plain column on an already-RLS-scoped table (pipeline_runs carries tenant_id
-- and a tenant_isolation policy from 0001/0021): no RLS policy / grant change,
-- same as migration 0041.

ALTER TABLE public.pipeline_runs
  ADD COLUMN IF NOT EXISTS triggered_by_user_id text;
