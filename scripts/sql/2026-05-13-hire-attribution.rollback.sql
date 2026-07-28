-- ============================================================================
-- ROLLBACK for 2026-05-13-hire-attribution.sql
--
-- WARNING: This is destructive. It drops the new tables and removes the new
--          columns from `applications` and `tenants`. Any data captured by
--          the attribution engine (hire_attribution_events, offer_letters,
--          billing_invoices, etc.) will be permanently lost.
--
--          DO NOT run this in production unless you have a confirmed full
--          backup AND you have reviewed every dependent application code path.
--
-- Apply with:  psql "$DATABASE_URL" -f scripts/sql/2026-05-13-hire-attribution.rollback.sql
-- ============================================================================

BEGIN;

-- 1. Drop new tables (children before parents — no FKs declared, but drop
--    in dependency order anyway to be safe with future FK additions).
DROP TABLE IF EXISTS attribution_disputes;
DROP TABLE IF EXISTS billing_usage_records;
DROP TABLE IF EXISTS billing_invoices;
DROP TABLE IF EXISTS tenant_integrations;
DROP TABLE IF EXISTS offer_letters;
DROP TABLE IF EXISTS hire_attribution_events;
DROP TABLE IF EXISTS linkedin_profile_snapshots;

-- 2. Drop the indexes added to applications & tenants
DROP INDEX IF EXISTS idx_applications_attribution_status;
DROP INDEX IF EXISTS idx_applications_originating_touch;
DROP INDEX IF EXISTS idx_applications_hired_at;
DROP INDEX IF EXISTS uq_tenants_stripe_customer_id;

-- 3. Remove additive columns from applications
ALTER TABLE applications
  DROP COLUMN IF EXISTS hired_at,
  DROP COLUMN IF EXISTS offer_extended_at,
  DROP COLUMN IF EXISTS offer_accepted_at,
  DROP COLUMN IF EXISTS attribution_score,
  DROP COLUMN IF EXISTS attribution_status,
  DROP COLUMN IF EXISTS originating_touch_at,
  DROP COLUMN IF EXISTS billed_at,
  DROP COLUMN IF EXISTS billed_amount_cents,
  DROP COLUMN IF EXISTS billing_currency;

-- 4. Remove additive columns from tenants
ALTER TABLE tenants
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  DROP COLUMN IF EXISTS billing_currency,
  DROP COLUMN IF EXISTS billing_region,
  DROP COLUMN IF EXISTS per_hire_fee_cents,
  DROP COLUMN IF EXISTS platform_fee_cents,
  DROP COLUMN IF EXISTS plan_started_at,
  DROP COLUMN IF EXISTS plan_renews_at;

-- 5. Drop enums (after columns that referenced them are gone)
DROP TYPE IF EXISTS tenant_integration_status;
DROP TYPE IF EXISTS tenant_integration_provider;
DROP TYPE IF EXISTS attribution_dispute_status;
DROP TYPE IF EXISTS billing_invoice_status;
DROP TYPE IF EXISTS attribution_signal_type;
DROP TYPE IF EXISTS attribution_status;

COMMIT;
