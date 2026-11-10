-- Additive only: do not push the full schema or replace RLS/grants.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_erased_at timestamp;
