BEGIN;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS internal_mobility boolean NOT NULL DEFAULT false;

COMMIT;