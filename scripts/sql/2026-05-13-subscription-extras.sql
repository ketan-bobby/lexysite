-- 2026-05-13: Subscription extras — credits ledger, partner program, billing,
-- and tenant columns (plan_activated_at, region, stripe_customer_id, partner_id).
--
-- Idempotent: re-runnable. Designed to coexist with drizzle-kit push.

-- ── Tenants extra columns ────────────────────────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'us';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_activated_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS partner_id TEXT;

-- Backfill plan_activated_at from created_at for existing rows
UPDATE tenants SET plan_activated_at = created_at WHERE plan_activated_at IS NULL OR plan_activated_at < created_at - INTERVAL '1 second';

-- ── Credit usage ledger ──────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE credit_kind AS ENUM ('interview', 'candidate_db_search', 'ai_generation', 'outreach_message');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS credit_usage_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT,
  kind        credit_kind NOT NULL,
  units       INTEGER NOT NULL DEFAULT 1,
  ref_id      TEXT,
  metadata    JSONB,
  occurred_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_usage_tenant_kind_time ON credit_usage_events (tenant_id, kind, occurred_at DESC);

-- ── Partner program ──────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE partner_status AS ENUM ('pending', 'active', 'suspended', 'churned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE partner_region AS ENUM ('us', 'eu', 'india', 'africa', 'pakistan', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE payout_status AS ENUM ('pending', 'approved', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS partners (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  contact_email  TEXT NOT NULL UNIQUE,
  company_name   TEXT,
  region         partner_region NOT NULL DEFAULT 'us',
  status         partner_status NOT NULL DEFAULT 'pending',
  rev_share_pct  NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  payout_method  JSONB,
  notes          TEXT,
  approved_at    TIMESTAMP,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partner_attribution_events (
  id                            TEXT PRIMARY KEY,
  partner_id                    TEXT NOT NULL,
  tenant_id                     TEXT NOT NULL,
  rev_share_pct_at_attribution  NUMERIC(5,2) NOT NULL,
  attributed_at                 TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pae_partner ON partner_attribution_events (partner_id);
CREATE INDEX IF NOT EXISTS idx_pae_tenant  ON partner_attribution_events (tenant_id);

CREATE TABLE IF NOT EXISTS partner_payouts (
  id                         TEXT PRIMARY KEY,
  partner_id                 TEXT NOT NULL,
  period_month               TEXT NOT NULL,
  attributed_revenue_cents   INTEGER NOT NULL,
  raw_payout_cents           INTEGER NOT NULL,
  payout_cents               INTEGER NOT NULL,
  margin_floor_applied       BOOLEAN NOT NULL DEFAULT FALSE,
  status                     payout_status NOT NULL DEFAULT 'pending',
  notes                      TEXT,
  paid_at                    TIMESTAMP,
  created_at                 TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payouts_partner_period ON partner_payouts (partner_id, period_month);

-- ── Billing (Stripe scaffolding) ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  stripe_subscription_id   TEXT NOT NULL UNIQUE,
  stripe_price_id          TEXT NOT NULL,
  plan_code                TEXT NOT NULL,
  status                   subscription_status NOT NULL DEFAULT 'incomplete',
  current_period_start     TIMESTAMP,
  current_period_end       TIMESTAMP,
  cancel_at_period_end     TEXT NOT NULL DEFAULT 'false',
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_subs_tenant ON billing_subscriptions (tenant_id);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  stripe_invoice_id   TEXT NOT NULL UNIQUE,
  amount_due_cents    INTEGER NOT NULL,
  amount_paid_cents   INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'usd',
  status              invoice_status NOT NULL DEFAULT 'draft',
  hosted_invoice_url  TEXT,
  invoice_pdf_url     TEXT,
  finalized_at        TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant ON billing_invoices (tenant_id);
