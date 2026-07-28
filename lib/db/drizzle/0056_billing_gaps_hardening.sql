-- 0056_billing_gaps_hardening.sql
--
-- Closes the manual-billing model gaps:
--   1. tenants.grace_period_days — nullable per-tenant grace override
--      (null = global SUBSCRIPTION_GRACE_DAYS default). Platform-admin-only
--      write via POST /tenants/:id/grace-period (reason required, audited).
--   2. fee_line_items generalised into a billing ledger: item_type
--      ('per_hire' default | 'proration' | 'adjustment' | 'seat_overage'),
--      hire-specific columns relaxed to nullable for non-hire items,
--      period_key for monthly seat-overage dedup, description free text.
--      Same review queue / CSV export as per-hire fees.
--   3. billing_alerts_sent — per-cycle claim table replacing the two
--      single-shot idempotency columns; enables an escalating dunning
--      cadence (e.g. -14/-7/-1/0 days) with the same claim-then-send
--      pattern (INSERT ... ON CONFLICT DO NOTHING is the atomic claim).
--      cycle_anchor = the paid_through_at the alert was measured against,
--      so recording a payment naturally starts a fresh cycle.
--
-- Class-B tables (app-code tenant seal). Grants for lexy_app included.

-- 1. Per-tenant grace override -----------------------------------------------
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS grace_period_days integer;
ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_grace_period_days_range;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_grace_period_days_range
  CHECK (grace_period_days IS NULL OR (grace_period_days >= 0 AND grace_period_days <= 365));

-- 2. Generalised billing ledger ----------------------------------------------
ALTER TABLE public.fee_line_items
  ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'per_hire',
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS period_key text;
ALTER TABLE public.fee_line_items
  DROP CONSTRAINT IF EXISTS fee_line_items_item_type_check;
ALTER TABLE public.fee_line_items
  ADD CONSTRAINT fee_line_items_item_type_check
  CHECK (item_type IN ('per_hire','proration','adjustment','seat_overage'));

ALTER TABLE public.fee_line_items ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN candidate_id  DROP NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN job_id        DROP NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN origin_channel DROP NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN evidence       DROP NOT NULL;

-- Per-hire rows must still carry their hire identity (fail-closed).
ALTER TABLE public.fee_line_items
  DROP CONSTRAINT IF EXISTS fee_line_items_per_hire_shape;
ALTER TABLE public.fee_line_items
  ADD CONSTRAINT fee_line_items_per_hire_shape
  CHECK (
    item_type <> 'per_hire'
    OR (application_id IS NOT NULL AND candidate_id IS NOT NULL
        AND job_id IS NOT NULL AND origin_channel IS NOT NULL
        AND evidence IS NOT NULL)
  );

-- One seat-overage line per tenant per month (the sweep's dedup claim).
CREATE UNIQUE INDEX IF NOT EXISTS fee_line_items_seat_overage_period_uq
  ON public.fee_line_items (tenant_id, period_key)
  WHERE item_type = 'seat_overage';

-- 3. Escalating dunning claim table ------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_alerts_sent (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    text NOT NULL,
  -- The paid_through_at this alert was measured against (ISO string). A new
  -- payment advances paid_through_at → new cycle → thresholds re-arm.
  cycle_anchor text NOT NULL,
  -- e.g. 'reminder_14d' | 'reminder_7d' | 'reminder_1d' | 'lapsed'
  alert_type   text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_alerts_sent_claim_uq UNIQUE (tenant_id, cycle_anchor, alert_type)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_alerts_sent TO lexy_app;
