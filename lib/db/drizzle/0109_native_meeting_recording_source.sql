-- Nullable provenance on the existing private, erasure-fenced row.
-- No provider tokens/URLs, new access policies, scoring or automatic processing.
BEGIN;
ALTER TABLE public.meeting_notes ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE public.meeting_notes ADD COLUMN IF NOT EXISTS native_source jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS meeting_notes_source_key_unique ON public.meeting_notes(source_key);
COMMIT;
