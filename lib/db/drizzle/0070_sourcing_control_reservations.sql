BEGIN;
CREATE TABLE IF NOT EXISTS sourcing_policies (
 job_id text PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
 tenant_id text NOT NULL REFERENCES tenants(id),
 revision integer NOT NULL CHECK (revision > 0),
 limits jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('draft','approved','paused')),
 brief_hash text NOT NULL,
 journey_id text REFERENCES recruiting_journeys(id),
 approved_by_id text,
 approved_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sourcing_reservations (
 id text PRIMARY KEY,
 job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 tenant_id text NOT NULL REFERENCES tenants(id),
 policy_revision integer NOT NULL CHECK (policy_revision > 0),
 policy_hash text NOT NULL,
 brief_hash text NOT NULL,
 journey_id text NOT NULL REFERENCES recruiting_journeys(id),
 limits jsonb NOT NULL,
 reserved_cents integer NOT NULL CHECK (reserved_cents > 0),
 status text NOT NULL CHECK (status IN ('reserved','paused','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_by_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sourcing_reservation_job ON sourcing_reservations(tenant_id,job_id,status);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sourcing_policies','sourcing_reservations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS sourcing_control_tenant_scope ON %I',t);
  EXECUTE format('CREATE POLICY sourcing_control_tenant_scope ON %I TO lexy_app USING (current_setting(''app.is_platform_admin'',true)=''true'' OR tenant_id=ANY(string_to_array(current_setting(''app.allowed_tenant_ids'',true),'',''))) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR tenant_id=ANY(string_to_array(current_setting(''app.allowed_tenant_ids'',true),'','')))',t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lexy_app',t);
 END LOOP;
END $$;
COMMIT;
