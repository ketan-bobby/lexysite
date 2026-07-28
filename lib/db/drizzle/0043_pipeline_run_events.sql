-- 0043_pipeline_run_events.sql
-- Persisted event stream for orchestrator PIPELINE runs (pipeline_runs) — the
-- durable counterpart to the in-memory orchestrator event buffer, which is lost
-- on every deploy. Mirrors the agent_runs event model (migration 0039):
-- tenant_id + FORCE RLS, ordered per-run `seq`, best-effort background writes via
-- the BYPASSRLS admin role which ALWAYS sets tenant_id explicitly.
--
-- A pipeline_run is the PARENT (one row per full multi-agent run); its events are
-- the per-stage lifecycle: run_started, step_started/step_completed per agent,
-- run_completed / run_failed / run_interrupted. The parent's `stages` jsonb is
-- KEPT as the Kanban's fast snapshot; this table is the additive audit trail.
--
-- ── run_activity_events view ─────────────────────────────────────────────────
-- The ONLY sanctioned read surface for CROSS-RUN activity. It normalizes the two
-- event streams (agent_run_events + pipeline_run_events) into one shape so
-- consumers never care which physical table an event came from. If the two run
-- models are ever unified (see docs/adr/0001-pipeline-run-events.md), this view
-- is the seam: consumers reading it will not need to change.

CREATE TABLE IF NOT EXISTS pipeline_run_events (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  run_id     text NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  type       text NOT NULL,
  step_name  text,
  message    text NOT NULL,
  count      integer,
  payload    jsonb,
  timestamp  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_run_events_run_seq_idx ON pipeline_run_events (run_id, seq);
CREATE INDEX IF NOT EXISTS pipeline_run_events_tenant_idx ON pipeline_run_events (tenant_id);
CREATE INDEX IF NOT EXISTS pipeline_run_events_timestamp_idx ON pipeline_run_events ("timestamp");

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_run_events TO lexy_app;

-- Tenant isolation identical to agent_run_events (migration 0039): FORCE so even
-- the table owner is scoped; app_tenant_in_scope() reads the request's tenant GUC.
ALTER TABLE pipeline_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_run_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pipeline_run_events;
CREATE POLICY tenant_isolation ON pipeline_run_events
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

-- Normalized cross-run activity read surface. security_invoker=true so RLS on the
-- underlying tables is enforced against the QUERYING role, not the view owner.
CREATE OR REPLACE VIEW run_activity_events
  WITH (security_invoker = true) AS
    SELECT run_id, 'agent'::text    AS run_type, tenant_id,
           type AS event_type, step_name, message, count, payload, "timestamp", seq
      FROM agent_run_events
    UNION ALL
    SELECT run_id, 'pipeline'::text AS run_type, tenant_id,
           type AS event_type, step_name, message, count, payload, "timestamp", seq
      FROM pipeline_run_events;

GRANT SELECT ON run_activity_events TO lexy_app;

COMMENT ON VIEW run_activity_events IS
  'SANCTIONED read surface for cross-run activity. Normalizes agent_run_events + pipeline_run_events into a single shape (run_id, run_type, tenant_id, event_type, timestamp, message, payload, step_name, count, seq). Do NOT read the underlying event tables directly for cross-run activity — read this view so consumers stay decoupled from which table an event lives in. Rationale + the deferred full-unification decision: docs/adr/0001-pipeline-run-events.md.';
