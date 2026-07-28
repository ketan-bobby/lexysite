-- Rollback for 2026-05-14-trial-extras.sql
-- Drops the three optional trial-context columns. Data in those columns
-- will be lost — only run if you intend to revert the migration.

ALTER TABLE pending_trial_signups
  DROP COLUMN IF EXISTS role,
  DROP COLUMN IF EXISTS team_size,
  DROP COLUMN IF EXISTS hiring_focus;
