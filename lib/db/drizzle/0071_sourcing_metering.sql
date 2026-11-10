BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS sourcing_reservation_scope_identity
 ON sourcing_reservations(tenant_id,job_id,id);
CREATE TABLE IF NOT EXISTS sourcing_execution_leases (
 reservation_id text PRIMARY KEY REFERENCES sourcing_reservations(id),
 tenant_id text NOT NULL REFERENCES tenants(id), job_id text NOT NULL REFERENCES jobs(id),
 actor_id text NOT NULL, generation integer NOT NULL CHECK (generation > 0),
 owner text NOT NULL, lease_until timestamptz NOT NULL,
 started_at timestamptz NOT NULL, deadline timestamptz NOT NULL,
 candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 CONSTRAINT sourcing_lease_parent_scope FOREIGN KEY(tenant_id,job_id,reservation_id)
  REFERENCES sourcing_reservations(tenant_id,job_id,id)
);
CREATE TABLE IF NOT EXISTS sourcing_cost_operations (
 id text PRIMARY KEY, reservation_id text NOT NULL REFERENCES sourcing_reservations(id),
 tenant_id text NOT NULL REFERENCES tenants(id), job_id text NOT NULL REFERENCES jobs(id),
 operation_key text NOT NULL, request_hash text NOT NULL, provider text NOT NULL,
 pricing_version text NOT NULL, quote_expires_at timestamptz NOT NULL, evidence text NOT NULL,
 billing_evidence text,
 upper_micros bigint NOT NULL CHECK (upper_micros > 0 AND upper_micros <= 100000000000),
 actual_micros bigint CHECK (actual_micros >= 0 AND actual_micros <= upper_micros),
 reported_micros bigint CHECK (reported_micros >= 0 AND reported_micros <= 100000000000),
 status text NOT NULL CHECK (status IN ('prepared','dispatching','uncertain','settled','void')),
 generation integer NOT NULL CHECK (generation > 0), attempt_token text NOT NULL,
 dispatched_at timestamptz, settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sourcing_cost_state CHECK ((status = 'settled') = (actual_micros IS NOT NULL)),
 CONSTRAINT sourcing_cost_operation_identity UNIQUE(reservation_id, operation_key),
 CONSTRAINT sourcing_cost_parent_scope FOREIGN KEY(tenant_id,job_id,reservation_id)
  REFERENCES sourcing_reservations(tenant_id,job_id,id)
);
CREATE INDEX IF NOT EXISTS sourcing_cost_scope ON sourcing_cost_operations(tenant_id,job_id,status);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sourcing_execution_leases','sourcing_cost_operations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS sourcing_meter_tenant_scope ON %I',t);
  EXECUTE format('CREATE POLICY sourcing_meter_tenant_scope ON %I TO lexy_app USING (current_setting(''app.is_platform_admin'',true)=''true'' OR tenant_id=ANY(string_to_array(current_setting(''app.allowed_tenant_ids'',true),'',''))) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR tenant_id=ANY(string_to_array(current_setting(''app.allowed_tenant_ids'',true),'','')))',t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lexy_app',t);
 END LOOP;
END $$;
COMMIT;
