-- Additive, explicitly applied migration. Existing private-table RLS,
-- privilege revocation and candidate erasure barriers remain in force.
ALTER TABLE interview_calendar_invitation_attempts
  ADD COLUMN IF NOT EXISTS changes jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='interview_calendar_invitation_attempts'::regclass
      AND conname='interview_invitation_changes_array'
  ) THEN
    ALTER TABLE interview_calendar_invitation_attempts
      ADD CONSTRAINT interview_invitation_changes_array
      CHECK (jsonb_typeof(changes)='array');
  END IF;
END $$;
