-- Full-length human-interview evidence. Apply only to the explicitly verified
-- target; development execution is not authorization to change production.
-- No RLS, grants, triggers, ownership or existing evidence is changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.meeting_notes
  DROP CONSTRAINT meeting_notes_byte_size_check,
  ADD CONSTRAINT meeting_notes_byte_size_check
    CHECK (byte_size > 0 AND byte_size <= 104857600);
COMMIT;
