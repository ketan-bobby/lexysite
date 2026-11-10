-- Recording OAuth is independent of Calendar OAuth. Private admin-pool only.
CREATE TABLE IF NOT EXISTS staff_google_meet_recordings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  revision text NOT NULL,
  client_fingerprint text NOT NULL,
  subject text,
  account_email text,
  refresh_token_enc text,
  connected_at timestamptz,
  needs_reconnect boolean NOT NULL DEFAULT false,
  flow_hash text,
  browser_hash text,
  verifier_enc text,
  nonce_hash text,
  flow_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_google_meet_recordings_connection_complete CHECK (
    (refresh_token_enc IS NULL AND subject IS NULL AND account_email IS NULL AND connected_at IS NULL)
    OR (refresh_token_enc IS NOT NULL AND subject IS NOT NULL AND account_email IS NOT NULL AND connected_at IS NOT NULL)
  ),
  CONSTRAINT staff_google_meet_recordings_flow_complete CHECK (
    (flow_hash IS NULL AND browser_hash IS NULL AND verifier_enc IS NULL AND nonce_hash IS NULL AND flow_expires_at IS NULL)
    OR (flow_hash IS NOT NULL AND browser_hash IS NOT NULL AND verifier_enc IS NOT NULL AND nonce_hash IS NOT NULL AND flow_expires_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_google_meet_recordings_flow_unique
  ON staff_google_meet_recordings(flow_hash);
ALTER TABLE staff_google_meet_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_google_meet_recordings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_google_meet_recordings FROM PUBLIC, lexy_app;
