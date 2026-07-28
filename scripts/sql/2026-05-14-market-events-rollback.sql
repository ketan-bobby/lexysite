-- Rollback for 2026-05-14-market-events.sql
DROP TABLE IF EXISTS candidate_market_events_sent;
DROP INDEX IF EXISTS idx_action_events_viewer;
ALTER TABLE candidate_action_events DROP COLUMN IF EXISTS viewer_tenant_id;
