-- Apply through the existing reviewed database rollout, never at app startup.
CREATE TABLE IF NOT EXISTS interview_offered_times (
  schedule_id text PRIMARY KEY REFERENCES interview_schedules(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  application_id text NOT NULL,
  proposal_version text NOT NULL,
  version text NOT NULL,
  alternatives jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE interview_offered_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_offered_times FORCE ROW LEVEL SECURITY;
-- This server-private table intentionally has no request-role policies.
REVOKE ALL ON TABLE interview_offered_times FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON interview_offered_times
  FOR EACH ROW EXECUTE FUNCTION lexy_erasure_write_barrier('candidate_id');
