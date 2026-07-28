-- migration 0028 — Outcome Labels & Quality-of-Hire Capture
--
-- Extend candidate_outcomes with:
--   1. A terminal pipeline label (outcome / outcome_at) so every closed
--      application — not just offer-track ones — carries a learning label.
--   2. A post-hire quality signal (hire_quality_score) plus the 30/90-day
--      pulse bookkeeping columns used by the post-hire-pulse scheduler.
--
-- All additive + IF NOT EXISTS, so this is safe to re-run.

ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "outcome"               text;
ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "outcome_at"            timestamptz;
ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "hire_quality_score"    real;
ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "pulse_30_sent_at"      timestamptz;
ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "pulse_30_responded_at" timestamptz;
ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "pulse_90_sent_at"      timestamptz;
ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "pulse_90_responded_at" timestamptz;
ALTER TABLE "candidate_outcomes" ADD COLUMN IF NOT EXISTS "pulse_responses"       jsonb;

-- Index the terminal label so coverage queries (hires, hires-with-quality) and
-- the pulse scheduler scans stay cheap.
CREATE INDEX IF NOT EXISTS "candidate_outcomes_outcome_idx" ON "candidate_outcomes" ("outcome");
