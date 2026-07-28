-- 0039_agent_runs.sql
-- Agent Run event model — the audit log of autonomous agent activity.
--
-- An AgentRun (currently agent_type = 'sourcing') owns an ordered stream of
-- agent_run_events. The recruiter UI polls a run's events and renders live
-- progress; real pipeline runs and simulated demo runs write to the SAME tables
-- so the frontend has one stable contract. Runs + events persist forever.
--
-- RLS: same tenant_isolation template as migration 0021/0034/0035 — scoped by
-- tenant_id via app_tenant_in_scope(). Background writers use the BYPASSRLS
-- admin role and always set tenant_id explicitly.

CREATE TABLE IF NOT EXISTS agent_runs (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  work_order_id text NOT NULL,
  agent_type    text NOT NULL DEFAULT 'sourcing',
  status        text NOT NULL DEFAULT 'queued',
  is_simulated  boolean NOT NULL DEFAULT false,
  triggered_by  text NOT NULL DEFAULT 'user',
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  started_at    timestamp,
  completed_at  timestamp,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_work_order_idx ON agent_runs (work_order_id);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_idx ON agent_runs (tenant_id);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  run_id     text NOT NULL,
  seq        integer NOT NULL,
  type       text NOT NULL,
  step_name  text,
  message    text NOT NULL,
  count      integer,
  payload    jsonb,
  timestamp  timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE so the per-run sequence is gap-tolerant but never duplicated — the
-- polling client pages by seq, so a duplicate seq would silently drop an event.
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_events_run_seq_idx ON agent_run_events (run_id, seq);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs TO lexy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_run_events TO lexy_app;

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_runs;
CREATE POLICY tenant_isolation ON agent_runs
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

ALTER TABLE agent_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_run_events;
CREATE POLICY tenant_isolation ON agent_run_events
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));
