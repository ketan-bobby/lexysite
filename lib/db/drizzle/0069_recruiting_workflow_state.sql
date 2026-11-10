-- Phase 2 planning only. Apply to a verified development target, never via push.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS recruiting_journeys (
  id text PRIMARY KEY, tenant_id text NOT NULL, job_id text NOT NULL REFERENCES jobs(id),
  version integer NOT NULL CHECK (version > 0), status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  brief_hash text NOT NULL, brief jsonb NOT NULL, interview_path text NOT NULL,
  steps jsonb NOT NULL, created_by_id text NOT NULL, approved_by_id text, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recruiting_journey_approval CHECK ((status='draft' AND approved_by_id IS NULL AND approved_at IS NULL) OR (status='approved' AND approved_by_id IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiting_journey_job_version ON recruiting_journeys(job_id,version);
CREATE TABLE IF NOT EXISTS recruiting_workflows (
  id text PRIMARY KEY, tenant_id text NOT NULL, job_id text NOT NULL REFERENCES jobs(id),
  candidate_id text NOT NULL REFERENCES candidates(id), journey_id text NOT NULL REFERENCES recruiting_journeys(id),
  journey_version integer NOT NULL, interview_path text NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','paused','cancelled','completed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), steps jsonb NOT NULL,
  created_by_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiting_workflow_open_candidate ON recruiting_workflows(job_id,candidate_id) WHERE status IN ('ready','paused');
CREATE INDEX IF NOT EXISTS recruiting_workflow_job_scope ON recruiting_workflows(tenant_id,job_id);
CREATE TABLE IF NOT EXISTS recruiting_workflow_events (
  id text PRIMARY KEY, tenant_id text NOT NULL, job_id text NOT NULL REFERENCES jobs(id),
  workflow_id text REFERENCES recruiting_workflows(id), journey_id text REFERENCES recruiting_journeys(id),
  action text NOT NULL, actor_id text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiting_workflow_event_scope ON recruiting_workflow_events(tenant_id,job_id,created_at);
CREATE TABLE IF NOT EXISTS recruiting_workflow_receipts (
  id text PRIMARY KEY, tenant_id text NOT NULL, job_id text NOT NULL REFERENCES jobs(id),
  key text NOT NULL, request_hash text NOT NULL, result_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiting_workflow_receipt_key ON recruiting_workflow_receipts(tenant_id,job_id,key);
-- Immutable journey snapshots, including privileged UPDATE writers.
CREATE OR REPLACE FUNCTION recruiting_journey_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' OR NEW.status <> 'approved'
     OR (to_jsonb(NEW) - 'status' - 'approved_by_id' - 'approved_at')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'approved_by_id' - 'approved_at') THEN
    RAISE EXCEPTION 'Journey snapshots are immutable; create a new version';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recruiting_journey_immutable ON recruiting_journeys;
CREATE TRIGGER recruiting_journey_immutable BEFORE UPDATE ON recruiting_journeys FOR EACH ROW EXECUTE FUNCTION recruiting_journey_immutable();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recruiting_journeys','recruiting_workflows','recruiting_workflow_events','recruiting_workflow_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS recruiting_tenant_scope ON %I',t);
    EXECUTE format('CREATE POLICY recruiting_tenant_scope ON %I TO lexy_app USING (current_setting(''app.is_platform_admin'',true)=''true'' OR tenant_id=ANY(string_to_array(current_setting(''app.allowed_tenant_ids'',true),'',''))) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR tenant_id=ANY(string_to_array(current_setting(''app.allowed_tenant_ids'',true),'','')))',t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lexy_app',t);
  END LOOP;
END $$;
COMMIT;
