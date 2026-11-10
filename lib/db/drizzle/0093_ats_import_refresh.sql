BEGIN;
ALTER TABLE ats_imported_applications
  ADD COLUMN IF NOT EXISTS refresh_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS availability text NOT NULL DEFAULT 'unchecked';
CREATE TABLE IF NOT EXISTS ats_import_observations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  record_id text NOT NULL REFERENCES ats_imported_applications(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  actor_id text NOT NULL,
  availability text NOT NULL CHECK (availability IN ('available','unavailable')),
  snapshot jsonb NOT NULL,
  checked_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ats_import_observation_key_unique
  ON ats_import_observations(record_id,key);
CREATE UNIQUE INDEX IF NOT EXISTS ats_import_observation_revision_unique
  ON ats_import_observations(record_id,revision);
ALTER TABLE ats_import_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_import_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ats_import_observations FROM PUBLIC, lexy_app;
COMMIT;
