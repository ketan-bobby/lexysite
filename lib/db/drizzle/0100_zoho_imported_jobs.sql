-- Reviewed local draft intake. No remote operations, stages or candidate enrollment.
BEGIN;
CREATE TABLE zoho_imported_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_ref text NOT NULL,
  external_job_id text NOT NULL,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zoho_imported_job_identity
  ON zoho_imported_jobs(tenant_id, account_ref, external_job_id);
ALTER TABLE zoho_imported_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_imported_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE zoho_imported_jobs FROM PUBLIC, lexy_app;
COMMIT;
