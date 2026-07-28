-- Rollback for 0013_manual_billing_fields.sql
DROP INDEX IF EXISTS tenants_paid_through_at_idx;
ALTER TABLE tenants
  DROP COLUMN IF EXISTS paid_through_at,
  DROP COLUMN IF EXISTS billing_notes;
