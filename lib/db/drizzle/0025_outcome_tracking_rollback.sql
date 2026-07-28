-- rollback 0025 — Outcome Tracking Phase 1
-- Drops the new tables and enum. Postgres does not support removing enum
-- values, so the application_stage additions are left in place (they are
-- additive and backward-compatible).

DROP TABLE IF EXISTS "candidate_events";
DROP TYPE  IF EXISTS "candidate_event_type";
DROP TABLE IF EXISTS "candidate_outcomes";
