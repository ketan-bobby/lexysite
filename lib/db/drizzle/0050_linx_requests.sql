-- 0050_linx_requests.sql
--
-- LINX engagement feature — cross-tenant request/handoff workflow.
-- A client tenant's recruiter asks the LINX tenant for help filling a role;
-- LINX accepts/declines; on accept a requisition is created INSIDE LINX's
-- tenant from job METADATA only. NO candidate data crosses the tenant
-- boundary through this table, and there is NO billing logic — status only.
--
-- Visibility is DUAL-tenant and nothing else; WRITE AUTHORITY is asymmetric:
--   SELECT: originating tenant (tenant_id) OR the LINX tenant (linx_tenant_id)
--   INSERT: originating tenant ONLY — requests always start client-side
--   UPDATE: either party (client edits/closes, LINX responds), but the
--           ownership columns (tenant_id, linx_tenant_id, job_id,
--           requested_by_user_id) are frozen by trigger after insert
--   DELETE: originating tenant ONLY (withdraw its own request)
-- Enforced with FORCE RLS (Class-A pattern, mirrors migration 0043). App
-- routes must ALSO apply the same predicates explicitly (dev strips RLS on
-- most tables; the policy is the prod backstop, not the only seal).

CREATE TABLE IF NOT EXISTS linx_requests (
  id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id            text NOT NULL,
  job_id               text NOT NULL,
  requested_by_user_id text NOT NULL,
  contact_name         text NOT NULL,
  contact_email        text NOT NULL,
  note                 text,
  status               text NOT NULL DEFAULT 'pending'
                         CONSTRAINT linx_requests_status_check
                         CHECK (status IN ('pending','accepted','declined','filled','closed')),
  decline_reason       text,
  linx_tenant_id       text NOT NULL,
  linx_req_id          text,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  responded_at         timestamptz,
  resolved_at          timestamptz
);
-- Re-runnable on a pre-fix dev table: ensure the id default exists.
ALTER TABLE linx_requests ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

CREATE INDEX IF NOT EXISTS linx_requests_tenant_idx      ON linx_requests (tenant_id, requested_at);
CREATE INDEX IF NOT EXISTS linx_requests_linx_tenant_idx ON linx_requests (linx_tenant_id, status, requested_at);
CREATE INDEX IF NOT EXISTS linx_requests_job_idx         ON linx_requests (job_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON linx_requests TO lexy_app;

ALTER TABLE linx_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE linx_requests FORCE ROW LEVEL SECURITY;

-- Drop the earlier over-broad FOR ALL policy (pre-fix dev installs) and any
-- prior copies of the split policies so this file is idempotent.
DROP POLICY IF EXISTS linx_dual_tenant_isolation ON linx_requests;
DROP POLICY IF EXISTS linx_requests_select ON linx_requests;
DROP POLICY IF EXISTS linx_requests_insert ON linx_requests;
DROP POLICY IF EXISTS linx_requests_update ON linx_requests;
DROP POLICY IF EXISTS linx_requests_delete ON linx_requests;

-- Read: both parties, nobody else.
CREATE POLICY linx_requests_select ON linx_requests
  FOR SELECT TO lexy_app
  USING (app_tenant_in_scope(tenant_id) OR app_tenant_in_scope(linx_tenant_id));

-- Create: client-origin ONLY. A LINX-scoped session cannot mint requests
-- "from" arbitrary client tenants.
CREATE POLICY linx_requests_insert ON linx_requests
  FOR INSERT TO lexy_app
  WITH CHECK (app_tenant_in_scope(tenant_id));

-- Update: either party may progress the workflow; the row must still belong
-- to the updater's scope afterwards (ownership columns are trigger-frozen).
CREATE POLICY linx_requests_update ON linx_requests
  FOR UPDATE TO lexy_app
  USING (app_tenant_in_scope(tenant_id) OR app_tenant_in_scope(linx_tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id) OR app_tenant_in_scope(linx_tenant_id));

-- Delete: originating tenant only (withdrawing its own request).
CREATE POLICY linx_requests_delete ON linx_requests
  FOR DELETE TO lexy_app
  USING (app_tenant_in_scope(tenant_id));

-- Ownership columns are immutable after insert — applies to EVERY role
-- (including admin/bypass writers), so neither side can "move" a request to
-- a different tenant, job, or requester after creation.
CREATE OR REPLACE FUNCTION linx_requests_freeze_ownership() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id            IS DISTINCT FROM OLD.tenant_id
     OR NEW.linx_tenant_id    IS DISTINCT FROM OLD.linx_tenant_id
     OR NEW.job_id            IS DISTINCT FROM OLD.job_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id THEN
    RAISE EXCEPTION 'linx_requests ownership columns are immutable (tenant_id/linx_tenant_id/job_id/requested_by_user_id)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS linx_requests_freeze_ownership_trg ON linx_requests;
CREATE TRIGGER linx_requests_freeze_ownership_trg
  BEFORE UPDATE ON linx_requests
  FOR EACH ROW EXECUTE FUNCTION linx_requests_freeze_ownership();
