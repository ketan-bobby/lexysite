-- ============================================================================
-- 0010 — Sales-led billing term + plan-limit-hit email idempotency ledger
-- ============================================================================
--
-- Two unrelated-but-co-shipped changes:
--
-- 1) tenants.billing_term — closed enum {monthly, annual}, default 'monthly'.
--    Set by sales on contract signing. Drives which Stripe Price ID set is
--    used at checkout (monthly vs. annual). NOT exposed as a customer-facing
--    toggle — the in-app /subscription page renders it read-only as a badge.
--    Backfill: all existing rows are monthly today, so the DEFAULT covers
--    every row at column-add time.
--
-- 2) plan_limit_notifications — single row written the moment a "you've hit
--    your plan limit" email is sent. The unique index on (tenant_id, kind,
--    period_key) lets us use `INSERT ... ON CONFLICT DO NOTHING` to get
--    atomic "at most one email per (tenant, kind, period)" semantics across
--    concurrent API workers.
--
--    period_key is opaque text — "YYYY-MM" for monthly meters, "lifetime"
--    for one-shot caps (seats, sub-clients, demo). kind is opaque text so
--    adding a new limit doesn't require a migration; the universe of valid
--    kinds lives in artifacts/api-server/src/lib/plan-enforcement.ts.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE tenant_billing_term AS ENUM ('monthly', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS billing_term tenant_billing_term NOT NULL DEFAULT 'monthly';

CREATE TABLE IF NOT EXISTS plan_limit_notifications (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  kind        text NOT NULL,
  period_key  text NOT NULL,
  sent_at     timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_limit_notifications_tenant_kind_period_uq
  ON plan_limit_notifications (tenant_id, kind, period_key);
