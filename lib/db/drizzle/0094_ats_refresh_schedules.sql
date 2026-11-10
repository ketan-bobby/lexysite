BEGIN;
CREATE TABLE IF NOT EXISTS ats_refresh_schedules (
 id text PRIMARY KEY, tenant_id text NOT NULL, job_id text NOT NULL,
 workflow_id text NOT NULL REFERENCES recruiting_workflows(id) ON DELETE CASCADE,
 owner_user_id text NOT NULL, revision integer NOT NULL,
 status text NOT NULL CHECK (status IN ('enabled','paused')),
 record_ids jsonb NOT NULL, interval_minutes integer NOT NULL CHECK (interval_minutes IN (60,360,1440)),
 binding_revision integer NOT NULL, workflow_revision integer NOT NULL,
 authority_hash text NOT NULL, next_run_at timestamptz,
 blocked_reason text, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ats_refresh_schedule_workflow_unique ON ats_refresh_schedules(workflow_id);
CREATE INDEX IF NOT EXISTS ats_refresh_schedule_due ON ats_refresh_schedules(status,next_run_at);
CREATE TABLE IF NOT EXISTS ats_refresh_runs (
 id text PRIMARY KEY, tenant_id text NOT NULL, job_id text NOT NULL,
 workflow_id text NOT NULL REFERENCES recruiting_workflows(id) ON DELETE CASCADE,
 schedule_id text NOT NULL REFERENCES ats_refresh_schedules(id) ON DELETE CASCADE,
 schedule_revision integer NOT NULL,
 status text NOT NULL CHECK (status IN ('running','completed','stopped','interrupted')),
 items jsonb NOT NULL, message text, started_at timestamptz NOT NULL, finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS ats_refresh_run_history ON ats_refresh_runs(tenant_id,workflow_id,started_at);
CREATE UNIQUE INDEX IF NOT EXISTS ats_refresh_one_running ON ats_refresh_runs(schedule_id) WHERE status='running';
ALTER TABLE ats_refresh_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_refresh_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE ats_refresh_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_refresh_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ats_refresh_schedules,ats_refresh_runs FROM PUBLIC,lexy_app;
COMMIT;
