-- Staff-provided Zoom links are private approvals, never API verification.
BEGIN;
CREATE TABLE IF NOT EXISTS interview_zoom_links (
  schedule_id text PRIMARY KEY REFERENCES interview_schedules(id) ON DELETE CASCADE,
  publication_id text NOT NULL,
  publisher_id text NOT NULL,
  application_id text NOT NULL,
  candidate_id text NOT NULL,
  snapshot_hash text NOT NULL,
  join_url text,
  approved_at timestamptz
);
ALTER TABLE interview_zoom_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_zoom_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE interview_zoom_links FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON interview_zoom_links
  FOR EACH ROW EXECUTE FUNCTION lexy_erasure_write_barrier('candidate_id');
COMMIT;
