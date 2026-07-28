-- ============================================================================
-- 0009 — tenants.region: lock to a closed pgEnum
-- ============================================================================
--
-- Multi-region Phase 0: regions become a fixed, code-controlled enum so the
-- application can route reliably (db.forRegion, AI provider adapter, S3
-- bucket prefix) and so we can't accidentally accept a typo'd region value
-- from an API caller or a misconfigured seed.
--
-- Existing rows are all 'us' (the previous text-column default), so the
-- USING cast is safe. The default is preserved.
--
-- Values:
--   us  — Launch cell (Replit DB today; us-east-1 RDS when we cut over)
--   in  — Launch cell (Mumbai ap-south-1, provisioned in Phase 1)
--   eu  — Reserved
--   uk  — Reserved
--   au  — Reserved
--   ca  — Reserved
--
-- Region immutability + parent-region inheritance are enforced in the app
-- layer (artifacts/api-server/src/routes/tenants.ts). A defensive DB trigger
-- will be added in Phase 1 once we have a second cell to defend against.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE tenant_region AS ENUM ('us', 'in', 'eu', 'uk', 'au', 'ca');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tenants
  ALTER COLUMN region DROP DEFAULT,
  ALTER COLUMN region TYPE tenant_region USING region::tenant_region,
  ALTER COLUMN region SET DEFAULT 'us'::tenant_region,
  ALTER COLUMN region SET NOT NULL;
