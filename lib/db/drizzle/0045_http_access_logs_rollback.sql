-- ============================================================================
-- 0045 ROLLBACK — drop http_access_logs
-- ============================================================================
DROP INDEX IF EXISTS http_access_logs_route_occurred_idx;
DROP INDEX IF EXISTS http_access_logs_status_occurred_idx;
DROP INDEX IF EXISTS http_access_logs_occurred_at_idx;
DROP TABLE IF EXISTS http_access_logs;
