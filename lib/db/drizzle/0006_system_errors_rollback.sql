-- Rollback for 0006

DROP INDEX IF EXISTS system_errors_route_occurred_idx;
DROP INDEX IF EXISTS system_errors_source_occurred_idx;
DROP INDEX IF EXISTS system_errors_occurred_at_idx;
DROP TABLE IF EXISTS system_errors;
