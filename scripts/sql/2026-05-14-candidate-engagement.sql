-- 2026-05-14-candidate-engagement.sql
-- Adds 3 new candidate-engagement structures:
--   1. candidate_achievements          — earned badges (first interview, profile complete, etc.)
--   2. candidate_skill_scores          — per-skill historical scores for the improvement sparkline
--   3. peer percentile columns         — fuzzy "you vs. country / world" bands on progress snapshots
--
-- All statements are idempotent and safe to re-run.

-- ───────────────────────────────────────────────────────────
-- 1. candidate_achievements
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candidate_achievements (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL,
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT 'trophy',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  earned_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_achievements_unique_idx
  ON candidate_achievements (candidate_id, code);

CREATE INDEX IF NOT EXISTS candidate_achievements_earned_idx
  ON candidate_achievements (candidate_id, earned_at DESC);

-- ───────────────────────────────────────────────────────────
-- 2. candidate_skill_scores
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candidate_skill_scores (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL,
  skill         TEXT NOT NULL,
  score         INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'baseline_interview',
  session_id    TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS candidate_skill_scores_lookup_idx
  ON candidate_skill_scores (candidate_id, skill, created_at DESC);

-- ───────────────────────────────────────────────────────────
-- 3. peer percentile columns on candidate_progress_snapshots
-- ───────────────────────────────────────────────────────────
ALTER TABLE candidate_progress_snapshots
  ADD COLUMN IF NOT EXISTS peer_pct_country  INTEGER,
  ADD COLUMN IF NOT EXISTS peer_pct_global   INTEGER,
  ADD COLUMN IF NOT EXISTS peer_band_country TEXT,
  ADD COLUMN IF NOT EXISTS peer_band_global  TEXT,
  ADD COLUMN IF NOT EXISTS country           TEXT,
  ADD COLUMN IF NOT EXISTS peer_updated_at   TIMESTAMP;

-- ───────────────────────────────────────────────────────────
-- 4. Last-sent timestamp for weekly digest (stored on candidates)
-- ───────────────────────────────────────────────────────────
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS weekly_digest_last_sent_at TIMESTAMP;
