-- Approved local profile intake. Private provenance; no stage/application writes.
BEGIN;
CREATE TABLE IF NOT EXISTS ats_candidate_profiles (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  system text NOT NULL,
  account_ref text NOT NULL,
  external_candidate_id text NOT NULL,
  candidate_id text NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  fields text[] NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ats_profile_external_person_unique
  ON ats_candidate_profiles(tenant_id, system, account_ref, external_candidate_id);
CREATE UNIQUE INDEX IF NOT EXISTS ats_profile_request_unique
  ON ats_candidate_profiles(tenant_id, idempotency_key);
ALTER TABLE ats_candidate_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_candidate_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ats_candidate_profiles FROM PUBLIC, lexy_app;
COMMIT;
