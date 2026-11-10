-- Private source evidence on the existing staff-only, erased-candidate-fenced
-- row. No new access policy, scoring input, named identity or automatic action.
ALTER TABLE public.meeting_notes
  ADD COLUMN IF NOT EXISTS speaker_evidence jsonb;
