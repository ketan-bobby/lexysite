-- 0040_icp_location_rollback.sql
-- Revert 0040_icp_location.sql.

ALTER TABLE ideal_candidate_profiles
  DROP COLUMN IF EXISTS location;
