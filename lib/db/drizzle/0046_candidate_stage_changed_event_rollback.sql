-- Rollback 0046
--
-- Postgres cannot DROP a single value from an enum type without recreating the
-- type and rewriting every dependent column. The added 'STAGE_CHANGED' value is
-- harmless when unused, so this rollback is intentionally a documented no-op.
-- To fully remove it: recreate candidate_event_type without the value and
-- migrate candidate_events.event_type off it first.
SELECT 1;
