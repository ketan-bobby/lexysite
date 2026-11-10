-- OAuth custody only. This migration does not connect or import remote records.
BEGIN;
CREATE TABLE zoho_recruit_accounts (
  tenant_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision text NOT NULL,
  fingerprint text NOT NULL,
  flow_hash text,
  browser_hash text,
  flow_expires_at timestamptz,
  account_ref text,
  company_name text,
  refresh_token_enc text,
  approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zoho_recruit_account_ref_unique ON zoho_recruit_accounts(account_ref);
ALTER TABLE zoho_recruit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_recruit_accounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE zoho_recruit_accounts FROM PUBLIC, lexy_app;
COMMIT;
