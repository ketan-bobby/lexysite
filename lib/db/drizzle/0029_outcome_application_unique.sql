-- 0029_outcome_application_unique.sql
--
-- Enforce one candidate_outcomes row per application at the DB layer. This is
-- the conflict target for the atomic upserts in record-terminal-outcome.ts and
-- routes/outcomes.ts (upsertOutcome) — without it, concurrent terminal
-- transitions / double-clicks could insert duplicate outcome rows and inflate
-- the quality-of-hire coverage metrics.
--
-- The pre-existing 0025 index on application_id was non-unique; this replaces
-- the uniqueness guarantee with a UNIQUE index. Safe: application_id is NOT NULL.

CREATE UNIQUE INDEX IF NOT EXISTS "candidate_outcomes_application_id_uniq"
  ON "candidate_outcomes" ("application_id");
