-- Existing grants remain read-only. Write consent requires a new verified OAuth flow.
ALTER TABLE staff_google_calendars
  ADD COLUMN IF NOT EXISTS invitation_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flow_invitations boolean NOT NULL DEFAULT false;
ALTER TABLE interview_calendar_invitation_attempts
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'outlook',
  ADD COLUMN IF NOT EXISTS google_snapshot jsonb;
-- One schedule primary key remains the cross-provider send-attempt boundary.
ALTER TABLE staff_google_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_google_calendars FORCE ROW LEVEL SECURITY;
REVOKE ALL ON staff_google_calendars FROM PUBLIC, lexy_app;
ALTER TABLE interview_calendar_invitation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_calendar_invitation_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON interview_calendar_invitation_attempts FROM PUBLIC, lexy_app;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='staff_google_calendars'::regclass AND conname='staff_google_invitation_consent_complete') THEN
    ALTER TABLE staff_google_calendars ADD CONSTRAINT staff_google_invitation_consent_complete
      CHECK ((NOT invitation_consent OR refresh_token_enc IS NOT NULL) AND (NOT flow_invitations OR flow_hash IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='interview_calendar_invitation_attempts'::regclass AND conname='calendar_invitation_provider_complete') THEN
    ALTER TABLE interview_calendar_invitation_attempts ADD CONSTRAINT calendar_invitation_provider_complete
      CHECK ((provider='outlook' AND google_snapshot IS NULL) OR
        (provider='google' AND google_snapshot IS NOT NULL AND jsonb_typeof(google_snapshot)='object'
          AND google_snapshot ?& ARRAY['connectionRevision','subjectHash','snapshotHash','meetUrl','conferenceStatus']));
  END IF;
END $$;
