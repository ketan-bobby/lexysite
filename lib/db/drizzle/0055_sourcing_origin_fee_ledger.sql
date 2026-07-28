-- 0055_sourcing_origin_fee_ledger.sql
--
-- Sourcing-origin attribution + per-hire fee ledger (no payment processor).
--
-- 1. applications gains origin metadata (origin_set_at / origin_set_by /
--    origin_evidence). Evidence is captured at link time going forward only;
--    pre-launch rows keep NULL evidence and are therefore NEVER fee-eligible
--    (fail-closed — no retroactive billing on reconstructed evidence).
-- 2. A trigger makes entry_type and any non-null origin_evidence immutable.
--    The ONLY exception is the staff correction workflow, which sets the
--    transaction-local GUC app.allow_origin_correction = 'on' and writes a
--    permanent origin_corrections audit row.
-- 3. fee_line_items: one row per fee-eligible accepted offer. Lifecycle is
--    manual staff review → external invoicing; the platform never charges.
--
-- Class-B tables (app-code tenant seal). Grants for lexy_app included.

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS origin_set_at   timestamptz,
  ADD COLUMN IF NOT EXISTS origin_set_by   text,
  ADD COLUMN IF NOT EXISTS origin_evidence jsonb;

-- ── Origin immutability trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.applications_origin_immutable_fn()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_origin_correction', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.entry_type IS DISTINCT FROM OLD.entry_type THEN
    RAISE EXCEPTION 'applications.entry_type is immutable (use the origin correction workflow)';
  END IF;
  IF OLD.origin_evidence IS NOT NULL
     AND NEW.origin_evidence IS DISTINCT FROM OLD.origin_evidence THEN
    RAISE EXCEPTION 'applications.origin_evidence is immutable once set (use the origin correction workflow)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS applications_origin_immutable ON public.applications;
CREATE TRIGGER applications_origin_immutable
  BEFORE UPDATE ON public.applications
  FOR EACH ROW
  EXECUTE FUNCTION public.applications_origin_immutable_fn();

-- ── Fee line items ──────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.fee_line_item_status AS ENUM
    ('pending_review','approved','waived','disputed','invoiced_externally','paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.fee_line_items (
  id                    text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id             text NOT NULL,
  application_id        text NOT NULL UNIQUE,
  candidate_id          text NOT NULL,
  job_id                text NOT NULL,
  plan_code             text,
  amount                real NOT NULL,
  currency              text NOT NULL DEFAULT 'USD',
  origin_channel        text NOT NULL,
  evidence              jsonb NOT NULL,
  status                public.fee_line_item_status NOT NULL DEFAULT 'pending_review',
  reviewed_by           text,
  reviewed_at           timestamptz,
  review_reason         text,
  disputed_by           text,
  disputed_at           timestamptz,
  dispute_reason        text,
  external_invoice_ref  text,
  external_invoice_date timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fee_line_items_tenant_idx ON public.fee_line_items (tenant_id, status);
CREATE INDEX IF NOT EXISTS fee_line_items_status_idx ON public.fee_line_items (status, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fee_line_items TO lexy_app;

-- ── Origin corrections audit (append-only) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.origin_corrections (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id      text NOT NULL,
  application_id text NOT NULL,
  old_value      jsonb NOT NULL,
  new_value      jsonb NOT NULL,
  changed_by     text NOT NULL,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS origin_corrections_app_idx ON public.origin_corrections (application_id);

-- Append-only: app role may insert and read, never update/delete.
GRANT SELECT, INSERT ON public.origin_corrections TO lexy_app;
