-- ============================================================================
-- Career interview recording status
-- ============================================================================
--
-- Adds a nullable status marker to candidate_career_profiles so we can record
-- when a candidate ended the baseline interview before enough footage existed
-- (e.g. closed the tab in the first ~10s). A NULL status means "normal":
-- either no recording attempt, or a healthy recording referenced by
-- recording_url. The value 'abandoned_early' marks an interview that was
-- closed before the minimum length, so recruiters see why no video surfaced.
-- ============================================================================

ALTER TABLE candidate_career_profiles
  ADD COLUMN IF NOT EXISTS recording_status text;
