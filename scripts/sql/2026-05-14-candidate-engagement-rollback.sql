-- Rollback for 2026-05-14-candidate-engagement.sql
DROP TABLE IF EXISTS candidate_achievements;
DROP TABLE IF EXISTS candidate_skill_scores;

ALTER TABLE candidate_progress_snapshots
  DROP COLUMN IF EXISTS peer_pct_country,
  DROP COLUMN IF EXISTS peer_pct_global,
  DROP COLUMN IF EXISTS peer_band_country,
  DROP COLUMN IF EXISTS peer_band_global,
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS peer_updated_at;

ALTER TABLE candidates
  DROP COLUMN IF EXISTS weekly_digest_last_sent_at;
