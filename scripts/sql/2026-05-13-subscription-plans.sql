-- ============================================================================
-- 2026-05-13 — Subscription Plans: add 'demo' value to tenant_plan enum
-- ============================================================================
-- Adds the 'demo' tier so tenants can be provisioned via POST /plans/demo with
-- a 14-day expiry, 1 open job, and 5 interview sessions. Plan limits and
-- features are defined in code (artifacts/api-server/src/lib/plans.ts) — not
-- in the DB — so this migration only needs to extend the enum.
--
-- Idempotent: ADD VALUE IF NOT EXISTS.
-- ============================================================================

ALTER TYPE tenant_plan ADD VALUE IF NOT EXISTS 'demo' BEFORE 'starter';

-- Verification:
--   SELECT unnest(enum_range(NULL::tenant_plan));
--   Expect: demo, starter, growth, enterprise
