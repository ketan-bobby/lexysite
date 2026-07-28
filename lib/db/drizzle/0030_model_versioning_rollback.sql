-- 0030_model_versioning_rollback.sql
-- Reverses 0030_model_versioning.sql.

DROP INDEX IF EXISTS scoring_model_versions_one_live;
DROP INDEX IF EXISTS scoring_model_versions_version_uniq;
DROP TABLE IF EXISTS scoring_model_versions;

ALTER TABLE candidate_job_intelligence
  DROP COLUMN IF EXISTS model_version;
