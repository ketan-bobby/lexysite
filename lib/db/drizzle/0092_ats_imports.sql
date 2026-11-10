-- Server-private, explicit external metadata intake. No native pipeline writes.
BEGIN;
CREATE TABLE IF NOT EXISTS ats_imported_applications (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  workflow_id text NOT NULL REFERENCES recruiting_workflows(id) ON DELETE CASCADE,
  account_ref text NOT NULL,
  external_job_id text NOT NULL,
  external_application_id text NOT NULL,
  snapshot jsonb NOT NULL,
  imported_by text NOT NULL,
  observed_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ats_import_external_application_unique
  ON ats_imported_applications (tenant_id, account_ref, external_application_id);
ALTER TABLE ats_imported_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_imported_applications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ats_imported_applications FROM PUBLIC, lexy_app;
COMMIT;
