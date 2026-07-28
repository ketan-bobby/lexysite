-- 2026-05-14-trial-extras.sql
--
-- Adds three optional context columns to pending_trial_signups so the
-- public /start-trial form (lexy-site) can persist the prospect's role,
-- team size, and hiring focus. Previously those fields were collected
-- by the form but silently dropped at the API layer.
--
-- All columns are nullable so legacy rows (and the legacy /plans/demo
-- alias which doesn't send these fields) keep working unchanged.
--
-- Safe to re-run: uses IF NOT EXISTS.

ALTER TABLE pending_trial_signups
  ADD COLUMN IF NOT EXISTS role          text,
  ADD COLUMN IF NOT EXISTS team_size     text,
  ADD COLUMN IF NOT EXISTS hiring_focus  text;
