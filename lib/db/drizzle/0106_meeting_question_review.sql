-- Human-authored transcript annotations, not assessment or score evidence.
-- Inherits the server-private RLS/grants and candidate-erasure trigger of meeting_notes.
ALTER TABLE public.meeting_notes ADD COLUMN IF NOT EXISTS question_review jsonb;
