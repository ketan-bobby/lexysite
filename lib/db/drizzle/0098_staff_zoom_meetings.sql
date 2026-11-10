-- User-owned Zoom OAuth grants and fail-closed meeting operation receipts.
-- Applying this file never connects a Zoom account or sends an invitation.
BEGIN;
CREATE TABLE staff_zoom_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  revision text NOT NULL,
  client_fingerprint text NOT NULL,
  zoom_user_id text,
  email text,
  refresh_token_enc text,
  connected_at timestamptz,
  needs_reconnect boolean NOT NULL DEFAULT false,
  flow_hash text,
  browser_hash text,
  flow_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_zoom_accounts_flow_unique ON staff_zoom_accounts(flow_hash);
ALTER TABLE staff_zoom_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_zoom_accounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_zoom_accounts FROM PUBLIC, lexy_app;

CREATE TABLE interview_zoom_meetings (
  schedule_id text PRIMARY KEY REFERENCES interview_schedules(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  candidate_id text NOT NULL REFERENCES candidates(id),
  host_user_id text NOT NULL REFERENCES users(id),
  host_zoom_id text NOT NULL,
  operation_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','confirmed','uncertain','cancelled')),
  action text NOT NULL CHECK (action IN ('create','update','cancel')),
  meeting_id text,
  join_url text,
  snapshot_hash text NOT NULL,
  approved_at timestamptz NOT NULL,
  accepted_at timestamptz
);
ALTER TABLE interview_zoom_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_zoom_meetings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE interview_zoom_meetings FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON interview_zoom_meetings
  FOR EACH ROW EXECUTE FUNCTION lexy_erasure_write_barrier('candidate_id');
COMMIT;
