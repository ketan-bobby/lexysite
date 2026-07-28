-- Rollback for 0022_career_recording_status.sql
ALTER TABLE candidate_career_profiles
  DROP COLUMN IF EXISTS recording_status;
