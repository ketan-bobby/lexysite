-- DEVELOPMENT-ONLY schema change for candidate-approved introductions.
-- Do not apply this file through a production migration workflow. Production
-- rollout requires the database/RLS owner to review and deploy an equivalent
-- migration. This file exists so development databases can create the durable
-- table that the application schema declares.

BEGIN;

CREATE TABLE IF NOT EXISTS candidate_introductions (
  id text PRIMARY KEY,
  candidate_id text NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  strengths jsonb NOT NULL DEFAULT '[]'::jsonb,
  achievements jsonb NOT NULL DEFAULT '[]'::jsonb,
  career_direction text,
  role_preferences text,
  availability text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'withdrawn')),
  approved_at timestamp without time zone,
  withdrawn_at timestamp without time zone,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidate_introductions_tenant_status_idx
  ON candidate_introductions (tenant_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_introductions TO lexy_app;

ALTER TABLE candidate_introductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_introductions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS candidate_introductions_owner_or_submission_read ON candidate_introductions;
CREATE POLICY candidate_introductions_owner_or_submission_read
  ON candidate_introductions
  FOR SELECT TO lexy_app
  USING (
    app_tenant_in_scope(tenant_id)
    OR (
      status = 'approved'
      AND EXISTS (
        SELECT 1
        FROM talent_pool_submissions submission
        WHERE submission.candidate_id = candidate_introductions.candidate_id
          AND submission.client_tenant_id = current_setting('app.current_tenant_id', true)
          AND submission.status = 'active'
      )
    )
    OR (
      status = 'approved'
      AND EXISTS (
        SELECT 1
        FROM tenants viewer_tenant
        WHERE viewer_tenant.id = current_setting('app.current_tenant_id', true)
          AND viewer_tenant.candidate_database_access = true
      )
    )
  );

DROP POLICY IF EXISTS candidate_introductions_owner_insert ON candidate_introductions;
CREATE POLICY candidate_introductions_owner_insert
  ON candidate_introductions
  FOR INSERT TO lexy_app
  WITH CHECK (app_tenant_in_scope(tenant_id));

DROP POLICY IF EXISTS candidate_introductions_owner_update ON candidate_introductions;
CREATE POLICY candidate_introductions_owner_update
  ON candidate_introductions
  FOR UPDATE TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

DROP POLICY IF EXISTS candidate_introductions_owner_delete ON candidate_introductions;
CREATE POLICY candidate_introductions_owner_delete
  ON candidate_introductions
  FOR DELETE TO lexy_app
  USING (app_tenant_in_scope(tenant_id));

COMMIT;