-- ============================================================================
-- L3xy / Lexy — Hire Attribution & Billing Schema Update
-- Date:        2026-05-13
-- Author:      Engineering
-- Purpose:     Adds the database surface for the multi-signal hire-attribution
--              engine and Stripe billing integration described in
--              docs/L3xy_Unit_Economics_and_Pricing.md §7.
--
-- Properties:  Idempotent (safe to re-run). Additive only — no destructive
--              changes to existing tables. Uses IF NOT EXISTS / DO blocks
--              everywhere so partial application is recoverable.
--
-- Apply with:  psql "$DATABASE_URL" -f scripts/sql/2026-05-13-hire-attribution.sql
--              (or run inside your DB tool of choice)
--
-- Rollback:    See scripts/sql/2026-05-13-hire-attribution.rollback.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE attribution_status AS ENUM (
    'none', 'suspected', 'confirmed', 'disputed', 'billed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE attribution_signal_type AS ENUM (
    'mark_hired',
    'pipeline_transition',
    'offer_uploaded',
    'esign_webhook',
    'ats_webhook',
    'background_check',
    'reference_check',
    'candidate_confirm',
    'email_phrase',
    'linkedin_drift',
    'public_announcement',
    'calendar_invite',
    'payroll_webhook'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE billing_invoice_status AS ENUM (
    'draft', 'open', 'paid', 'void', 'uncollectible', 'disputed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE attribution_dispute_status AS ENUM (
    'open', 'tenant_won', 'platform_won', 'expired', 'withdrawn'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tenant_integration_provider AS ENUM (
    'greenhouse', 'lever', 'ashby', 'workday', 'workable',
    'docusign', 'dropbox_sign', 'pandadoc',
    'rippling', 'gusto', 'deel', 'bamboohr',
    'checkr', 'goodhire'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tenant_integration_status AS ENUM (
    'connected', 'expired', 'revoked', 'error', 'pending'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. ALTER existing `applications` table — additive columns only
-- ---------------------------------------------------------------------------

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS hired_at                  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS offer_extended_at         TIMESTAMP,
  ADD COLUMN IF NOT EXISTS offer_accepted_at         TIMESTAMP,
  ADD COLUMN IF NOT EXISTS attribution_score         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attribution_status        attribution_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS originating_touch_at      TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billed_at                 TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billed_amount_cents       INTEGER,
  ADD COLUMN IF NOT EXISTS billing_currency          TEXT;

-- Backfill originating_touch_at for existing applications using created_at.
-- This starts the 18-month attribution window from the historical first-touch
-- timestamp. Only fills NULLs; never overwrites a real value.
UPDATE applications
   SET originating_touch_at = created_at
 WHERE originating_touch_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_applications_attribution_status
  ON applications (tenant_id, attribution_status);

CREATE INDEX IF NOT EXISTS idx_applications_originating_touch
  ON applications (tenant_id, originating_touch_at);

CREATE INDEX IF NOT EXISTS idx_applications_hired_at
  ON applications (tenant_id, hired_at)
  WHERE hired_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. ALTER existing `tenants` table — Stripe + billing fields
-- ---------------------------------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id        TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id    TEXT,
  ADD COLUMN IF NOT EXISTS billing_currency          TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS billing_region            TEXT NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS per_hire_fee_cents        INTEGER,
  ADD COLUMN IF NOT EXISTS platform_fee_cents        INTEGER,
  ADD COLUMN IF NOT EXISTS plan_started_at           TIMESTAMP,
  ADD COLUMN IF NOT EXISTS plan_renews_at            TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_stripe_customer_id
  ON tenants (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. NEW TABLE — hire_attribution_events
--    The forensic audit log. Every observed signal writes one row.
--    This is the evidence packet we present to a customer in a dispute.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hire_attribution_events (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id         TEXT        NOT NULL,
  application_id    TEXT        NOT NULL,
  candidate_id      TEXT        NOT NULL,
  job_id            TEXT,
  signal_type       attribution_signal_type NOT NULL,
  signal_weight     INTEGER     NOT NULL,
  signal_source     TEXT        NOT NULL,
  signal_payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  observed_at       TIMESTAMP   NOT NULL,
  recorded_at       TIMESTAMP   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hae_tenant_app_observed
  ON hire_attribution_events (tenant_id, application_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_hae_candidate_signal
  ON hire_attribution_events (candidate_id, signal_type);

CREATE INDEX IF NOT EXISTS idx_hae_tenant_recorded
  ON hire_attribution_events (tenant_id, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- 5. NEW TABLE — offer_letters
--    PDF capture + LLM-extracted structured fields. One row per offer
--    extended (an application can have at most one active offer at a time).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offer_letters (
  id                  TEXT      PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id           TEXT      NOT NULL,
  application_id      TEXT      NOT NULL,
  candidate_id        TEXT      NOT NULL,
  file_url            TEXT      NOT NULL,
  file_size_bytes     INTEGER,
  parsed_salary_cents BIGINT,
  parsed_currency     TEXT,
  parsed_start_date   DATE,
  parsed_company      TEXT,
  parsed_role_title   TEXT,
  extraction_method   TEXT      NOT NULL DEFAULT 'llm_pdf_parse',
  extracted_at        TIMESTAMP,
  uploaded_by         TEXT,
  uploaded_at         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offer_letters_tenant_app
  ON offer_letters (tenant_id, application_id);

-- ---------------------------------------------------------------------------
-- 6. NEW TABLE — tenant_integrations
--    OAuth tokens for ATS / e-sign / payroll providers. Tokens stored
--    encrypted at the application layer (bytea); never store plaintext here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_integrations (
  id                       TEXT      PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id                TEXT      NOT NULL,
  provider                 tenant_integration_provider NOT NULL,
  external_account_id      TEXT,
  access_token_encrypted   BYTEA,
  refresh_token_encrypted  BYTEA,
  token_expires_at         TIMESTAMP,
  webhook_secret           TEXT,
  scopes                   TEXT,
  status                   tenant_integration_status NOT NULL DEFAULT 'pending',
  status_error             TEXT,
  connected_at             TIMESTAMP,
  last_sync_at             TIMESTAMP,
  created_at               TIMESTAMP NOT NULL DEFAULT now(),
  updated_at               TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_integrations_tenant_provider
  ON tenant_integrations (tenant_id, provider);

CREATE INDEX IF NOT EXISTS idx_tenant_integrations_status
  ON tenant_integrations (status);

-- ---------------------------------------------------------------------------
-- 7. NEW TABLE — billing_invoices
--    Mirror of Stripe invoices for in-app display + dispute history.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_invoices (
  id                    TEXT      PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id             TEXT      NOT NULL,
  stripe_invoice_id     TEXT,
  period_start          TIMESTAMP NOT NULL,
  period_end            TIMESTAMP NOT NULL,
  subscription_cents    INTEGER   NOT NULL DEFAULT 0,
  usage_cents           INTEGER   NOT NULL DEFAULT 0,
  total_cents           INTEGER   NOT NULL DEFAULT 0,
  currency              TEXT      NOT NULL DEFAULT 'USD',
  status                billing_invoice_status NOT NULL DEFAULT 'draft',
  hosted_invoice_url    TEXT,
  pdf_url               TEXT,
  issued_at             TIMESTAMP,
  paid_at               TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoices_stripe_id
  ON billing_invoices (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant_period
  ON billing_invoices (tenant_id, period_start DESC);

-- ---------------------------------------------------------------------------
-- 8. NEW TABLE — billing_usage_records
--    The bridge between a confirmed hire and a Stripe Usage Record.
--    One row per `hire.confirmed` event metered to Stripe.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_usage_records (
  id                       TEXT      PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id                TEXT      NOT NULL,
  application_id           TEXT      NOT NULL,
  candidate_id             TEXT      NOT NULL,
  attribution_score        INTEGER   NOT NULL,
  stripe_usage_record_id   TEXT,
  stripe_subscription_item TEXT,
  amount_cents             INTEGER   NOT NULL,
  currency                 TEXT      NOT NULL DEFAULT 'USD',
  metered_at               TIMESTAMP NOT NULL DEFAULT now(),
  invoice_id               TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_usage_application
  ON billing_usage_records (application_id);

CREATE INDEX IF NOT EXISTS idx_billing_usage_tenant_metered
  ON billing_usage_records (tenant_id, metered_at DESC);

-- ---------------------------------------------------------------------------
-- 9. NEW TABLE — attribution_disputes
--    14-day customer dispute workflow.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS attribution_disputes (
  id                   TEXT      PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id            TEXT      NOT NULL,
  application_id       TEXT      NOT NULL,
  usage_record_id      TEXT,
  invoice_id           TEXT,
  opened_by            TEXT,
  opened_at            TIMESTAMP NOT NULL DEFAULT now(),
  deadline_at          TIMESTAMP NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  status               attribution_dispute_status NOT NULL DEFAULT 'open',
  tenant_evidence      JSONB     NOT NULL DEFAULT '{}'::jsonb,
  platform_evidence    JSONB     NOT NULL DEFAULT '{}'::jsonb,
  resolution_at        TIMESTAMP,
  resolution_notes     TEXT,
  resolved_by          TEXT
);

CREATE INDEX IF NOT EXISTS idx_attribution_disputes_tenant_status
  ON attribution_disputes (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_attribution_disputes_deadline
  ON attribution_disputes (deadline_at)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- 10. NEW TABLE — linkedin_profile_snapshots
--     Cross-attribution support for the LinkedIn drift monitor. Each row is
--     one observation of a candidate's LinkedIn profile at a point in time.
--     The drift detector compares consecutive snapshots and emits
--     hire_attribution_events of type 'linkedin_drift' when the employer
--     changes within the 18-month attribution window of any tenant.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS linkedin_profile_snapshots (
  id                              TEXT      PRIMARY KEY DEFAULT gen_random_uuid()::text,
  candidate_id                    TEXT      NOT NULL,
  linkedin_url                    TEXT      NOT NULL,
  current_employer                TEXT,
  current_title                   TEXT,
  current_employer_started_at     DATE,
  raw_payload                     JSONB     NOT NULL DEFAULT '{}'::jsonb,
  fetched_at                      TIMESTAMP NOT NULL DEFAULT now(),
  detected_employer_change_at     TIMESTAMP,
  previous_employer               TEXT,
  cross_attributed_to_tenant_id   TEXT,
  cross_attribution_status        TEXT      NOT NULL DEFAULT 'none'
                                   CHECK (cross_attribution_status IN
                                          ('none','flagged','billed','disputed','dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_lps_candidate_fetched
  ON linkedin_profile_snapshots (candidate_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_lps_current_employer
  ON linkedin_profile_snapshots (current_employer)
  WHERE current_employer IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lps_drift_unclaimed
  ON linkedin_profile_snapshots (detected_employer_change_at DESC)
  WHERE cross_attribution_status = 'flagged';

-- ---------------------------------------------------------------------------
-- 11. Audit-log enrichment — extend allowed action strings
--     (No schema change; documentation comment only. The `recordAudit()`
--     utility writes free-form text actions, so just call it with these:
--
--       application.stage.transition
--       application.offer.extended
--       application.offer.accepted
--       application.hire.suspected
--       application.hire.confirmed
--       application.hire.disputed
--       attribution.signal.recorded
--       billing.invoice.issued
--       billing.usage.metered
--       integration.connected
--       integration.disconnected
--     )
-- ---------------------------------------------------------------------------

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification — run these queries after applying the migration:
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='applications' AND column_name LIKE '%attribution%';
--   --> attribution_score, attribution_status
--
--   SELECT to_regclass('hire_attribution_events') IS NOT NULL AS ok;  -- t
--   SELECT to_regclass('offer_letters') IS NOT NULL AS ok;            -- t
--   SELECT to_regclass('tenant_integrations') IS NOT NULL AS ok;      -- t
--   SELECT to_regclass('billing_invoices') IS NOT NULL AS ok;         -- t
--   SELECT to_regclass('billing_usage_records') IS NOT NULL AS ok;    -- t
--   SELECT to_regclass('attribution_disputes') IS NOT NULL AS ok;     -- t
--   SELECT to_regclass('linkedin_profile_snapshots') IS NOT NULL AS ok;-- t
--
--   SELECT count(*) FROM applications WHERE originating_touch_at IS NULL;
--   --> 0  (all backfilled)
--
-- ---------------------------------------------------------------------------
