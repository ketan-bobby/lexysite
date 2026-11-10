-- Explicit staff sharing consent, separate from OAuth calendar permission.
CREATE TABLE IF NOT EXISTS calendar_panel_consents (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  mailbox_hash text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE calendar_panel_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_panel_consents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE calendar_panel_consents FROM PUBLIC, lexy_app;
