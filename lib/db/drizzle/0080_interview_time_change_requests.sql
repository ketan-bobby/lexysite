-- Additive, reviewed rollout; never run implicitly during API startup.
CREATE TABLE IF NOT EXISTS interview_time_change_requests (
  id text PRIMARY KEY,
  schedule_id text NOT NULL REFERENCES interview_schedules(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  application_id text NOT NULL,
  proposal_version text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text,
  CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_time_change_request_proposal
  ON interview_time_change_requests(schedule_id,candidate_id,application_id,proposal_version);
ALTER TABLE interview_time_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_time_change_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE interview_time_change_requests FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON interview_time_change_requests
  FOR EACH ROW EXECUTE FUNCTION lexy_erasure_write_barrier('candidate_id');
