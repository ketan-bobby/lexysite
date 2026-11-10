-- No OAuth credentials; allocations and identifier-only, job-bound receipts.
BEGIN;
CREATE TABLE IF NOT EXISTS employer_ats_bindings (
  tenant_id text PRIMARY KEY,
  connection_id text NOT NULL,
  account_ref text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending_employer','active','disconnected')),
  allocated_by text NOT NULL,
  confirmed_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_ats_connection_owner_unique
  ON employer_ats_bindings(connection_id);
CREATE TABLE IF NOT EXISTS ats_mapping_verifications (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  workflow_id text NOT NULL REFERENCES recruiting_workflows(id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  mapping_hash text NOT NULL,
  mapping jsonb NOT NULL,
  workflow_revision integer NOT NULL,
  binding_revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('checking','verified','failed','discarded')),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ats_verification_request_unique
  ON ats_mapping_verifications(tenant_id, workflow_id, key);
ALTER TABLE ats_mapping_verifications ADD COLUMN IF NOT EXISTS mapping jsonb NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ats_mapping_verifications'::regclass
    AND conname='ats_mapping_verifications_workflow_id_fkey') THEN
    ALTER TABLE ats_mapping_verifications ADD CONSTRAINT ats_mapping_verifications_workflow_id_fkey
      FOREIGN KEY(workflow_id) REFERENCES recruiting_workflows(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ats_mapping_verifications'::regclass
    AND conname='ats_mapping_verifications_candidate_id_fkey') THEN
    ALTER TABLE ats_mapping_verifications ADD CONSTRAINT ats_mapping_verifications_candidate_id_fkey
      FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE;
  END IF;
END;
$$;
ALTER TABLE employer_ats_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_ats_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE ats_mapping_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_mapping_verifications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE employer_ats_bindings, ats_mapping_verifications FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON ats_mapping_verifications
  FOR EACH ROW EXECUTE FUNCTION lexy_erasure_write_barrier('candidate_id');
-- Never silently transfer an allocated project account to a different employer.
CREATE OR REPLACE FUNCTION lexy_ats_allocation_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.connection_id IS DISTINCT FROM OLD.connection_id OR
     NEW.account_ref IS DISTINCT FROM OLD.account_ref THEN
    RAISE EXCEPTION 'ATS allocation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER lexy_ats_allocation_identity_immutable
  BEFORE UPDATE ON employer_ats_bindings
  FOR EACH ROW EXECUTE FUNCTION lexy_ats_allocation_identity_immutable();
COMMIT;
