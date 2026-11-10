-- Explicit, account-revision-bound Google panel sharing. No existing grants opt in.
BEGIN;
CREATE TABLE IF NOT EXISTS google_panel_consents (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  connection_revision text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE google_panel_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_panel_consents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE google_panel_consents FROM PUBLIC, lexy_app;
COMMIT;
