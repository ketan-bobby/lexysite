-- 0041_application_entry_type_rollback.sql
-- Reverses 0041_application_entry_type.sql.

ALTER TABLE public.applications
  DROP COLUMN IF EXISTS entry_type;

DROP TYPE IF EXISTS public.application_entry_type;
