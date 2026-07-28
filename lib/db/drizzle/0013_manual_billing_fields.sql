-- 0013_manual_billing_fields.sql
--
-- Manual / sales-led billing support.
--
-- Adds two nullable columns to `tenants` so a platform_admin can record a
-- signed-contract paid-through date and free-form ops notes without going
-- through Stripe. The existing `status` column already gates access
-- (plan-enforcement.ts treats `suspended` as expired), so this migration
-- introduces no new state machine — it adds the data the existing checks
-- can consult.
--
-- `paid_through_at` semantics:
--   • NULL                    → no manual override; plan-expiry math uses
--                               plan_activated_at + plan.expiresAfterDays
--                               as before (preserves demo-trial behaviour).
--   • timestamptz in future   → tenant is paid through that date.
--   • timestamptz in past     → plan-enforcement returns planExpired=true
--                               (same effect as status='suspended').
--
-- `billing_notes` is operator-only context (PO number, contact, etc.) and
-- is NEVER surfaced to tenant_admins or recruiters.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS paid_through_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_notes   text;

CREATE INDEX IF NOT EXISTS tenants_paid_through_at_idx
  ON tenants (paid_through_at)
  WHERE paid_through_at IS NOT NULL;
