-- 0041_application_entry_type.sql
-- Add ENTRY_TYPE (origin) to applications so the funnel's "Sourced" stage and
-- the fairness reports can distinguish HOW a candidate entered a pipeline:
--   sourced  — surfaced by the AI sourcing agent (not a formal applicant)
--   applied  — candidate applied through the public career site
--   manual   — a recruiter manually added / linked the candidate to the job
--
-- entry_type is ORIGIN and is immutable; it is INDEPENDENT of `stage` (current
-- position). Conversion / compliance denominators use ('applied','manual');
-- volume / pipeline surfaces include all three entry types.
--
-- Defaults to 'applied' so every legacy insert path keeps working unchanged;
-- the backfill (see migration notes) immediately corrects existing rows to
-- their true origin (agent-sourced -> sourced, recruiter manual -> manual).
--
-- Plain column on an already-RLS-scoped table: no RLS policy / grant change.

DO $$ BEGIN
  CREATE TYPE public.application_entry_type AS ENUM ('sourced', 'applied', 'manual');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS entry_type public.application_entry_type NOT NULL DEFAULT 'applied';
