-- Rollback for 0009: convert tenants.region back to text.
ALTER TABLE tenants
  ALTER COLUMN region DROP DEFAULT,
  ALTER COLUMN region TYPE text USING region::text,
  ALTER COLUMN region SET DEFAULT 'us',
  ALTER COLUMN region SET NOT NULL;

DROP TYPE IF EXISTS tenant_region;
