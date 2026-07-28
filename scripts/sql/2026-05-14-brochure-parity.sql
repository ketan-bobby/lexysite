-- 2026-05-14 Brochure parity: candidate privacy controls + mock rubric + new round types
-- Idempotent. Safe to re-run.

BEGIN;

-- 1. Candidates: privacy controls -------------------------------------------------
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS hide_from_current_employer boolean NOT NULL DEFAULT false;

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS current_employer_domain text;

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS blocked_company_domains jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2. Prep sessions: per-dimension rubric + verbatim quotes -----------------------
ALTER TABLE prep_sessions
  ADD COLUMN IF NOT EXISTS rubric_scores jsonb;

ALTER TABLE prep_sessions
  ADD COLUMN IF NOT EXISTS verbatim_quotes jsonb;

-- 3. prep_mode enum: add product_sense + domain_deep_dive ------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'product_sense'
                 AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'prep_mode')) THEN
    ALTER TYPE prep_mode ADD VALUE 'product_sense';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'domain_deep_dive'
                 AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'prep_mode')) THEN
    ALTER TYPE prep_mode ADD VALUE 'domain_deep_dive';
  END IF;
END$$;

COMMIT;
