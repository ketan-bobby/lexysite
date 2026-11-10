-- Reviewed additive migration; do not apply implicitly during server startup.
CREATE TABLE IF NOT EXISTS interview_calendar_invitation_attempts (
  schedule_id text PRIMARY KEY REFERENCES interview_schedules(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  application_id text NOT NULL,
  organizer_id text NOT NULL,
  recipient_hash text NOT NULL,
  schedule_version text NOT NULL,
  transaction_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('attempted','accepted')),
  attempted_at timestamptz NOT NULL,
  accepted_at timestamptz,
  event_id text
);
ALTER TABLE interview_calendar_invitation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_calendar_invitation_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE interview_calendar_invitation_attempts FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON interview_calendar_invitation_attempts
  FOR EACH ROW EXECUTE FUNCTION lexy_erasure_write_barrier('candidate_id');
