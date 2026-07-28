-- 0030_model_versioning.sql
-- Task #23 — Model versioning & backtest harness.
--
-- 1. Stamp every intelligence row with the scoring model version that
--    produced its scores, so a backtest can attribute scores to a config
--    and a scoring change can be compared/rolled back by version.
-- 2. Add a platform-global registry of scoring configurations. The single
--    is_live row is the config used to score+persist new rows; rollback is
--    simply re-activating an earlier version.

ALTER TABLE candidate_job_intelligence
  ADD COLUMN IF NOT EXISTS model_version text;

CREATE TABLE IF NOT EXISTS scoring_model_versions (
  id          text PRIMARY KEY,
  version     text NOT NULL,
  label       text NOT NULL,
  config_json jsonb NOT NULL,
  is_live     boolean NOT NULL DEFAULT false,
  notes       text,
  created_at  timestamp NOT NULL DEFAULT now(),
  updated_at  timestamp NOT NULL DEFAULT now()
);

-- A version string identifies a config uniquely.
CREATE UNIQUE INDEX IF NOT EXISTS scoring_model_versions_version_uniq
  ON scoring_model_versions (version);

-- At most one configuration may be live at any time. Partial unique index
-- only covers is_live = true rows, so any number of inactive versions can
-- coexist while exactly one is live.
CREATE UNIQUE INDEX IF NOT EXISTS scoring_model_versions_one_live
  ON scoring_model_versions (is_live)
  WHERE is_live = true;
