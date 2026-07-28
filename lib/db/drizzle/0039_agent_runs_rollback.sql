-- 0039_agent_runs_rollback.sql — reverse of 0039_agent_runs.sql

DROP POLICY IF EXISTS tenant_isolation ON agent_run_events;
DROP POLICY IF EXISTS tenant_isolation ON agent_runs;
DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS agent_runs;
