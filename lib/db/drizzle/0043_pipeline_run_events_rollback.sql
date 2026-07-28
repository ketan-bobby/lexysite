-- Rollback for 0043_pipeline_run_events.sql
-- Dropping the view removes the cross-run read surface; dropping the table removes
-- the persisted pipeline event stream (the in-memory orchestrator buffer remains).
DROP VIEW IF EXISTS run_activity_events;
DROP TABLE IF EXISTS pipeline_run_events;
