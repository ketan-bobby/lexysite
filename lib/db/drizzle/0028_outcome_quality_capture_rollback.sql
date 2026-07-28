-- rollback 0028 — Outcome Labels & Quality-of-Hire Capture

DROP INDEX IF EXISTS "candidate_outcomes_outcome_idx";

ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "outcome";
ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "outcome_at";
ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "hire_quality_score";
ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "pulse_30_sent_at";
ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "pulse_30_responded_at";
ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "pulse_90_sent_at";
ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "pulse_90_responded_at";
ALTER TABLE "candidate_outcomes" DROP COLUMN IF EXISTS "pulse_responses";
