-- 0035_recruiter_mail_accounts.sql
-- Hybrid email sending — per-recruiter Microsoft 365 / Outlook mailbox connection.
--
-- Stores an ENCRYPTED Microsoft Graph refresh token so Lexy can send "as the
-- recruiter" from their own mailbox for manual 1:1 emails + the first/approved
-- outreach step, falling back to Amazon SES when no mailbox is connected or the
-- token fails. Reply-sync columns (graph_subscription_*, graph_delta_link)
-- support pulling Outlook replies back into Lexy.
--
-- RLS: same tenant_isolation template as migration 0021/0034, scoping by the
-- recruiter's own tenant_id.

CREATE TABLE IF NOT EXISTS recruiter_mail_accounts (
  id                            text PRIMARY KEY,
  tenant_id                     text NOT NULL,
  user_id                       text NOT NULL,
  provider                      text NOT NULL DEFAULT 'microsoft',
  email                         text NOT NULL DEFAULT '',
  home_account_id               text,
  refresh_token_enc             text,
  scopes                        text NOT NULL DEFAULT '',
  status                        text NOT NULL DEFAULT 'connected',
  last_error                    text,
  graph_subscription_id         text,
  graph_subscription_expires_at timestamp,
  graph_delta_link              text,
  connected_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                    timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recruiter_mail_accounts_user_uniq
  ON recruiter_mail_accounts (user_id);
CREATE INDEX IF NOT EXISTS recruiter_mail_accounts_tenant_idx
  ON recruiter_mail_accounts (tenant_id);
CREATE INDEX IF NOT EXISTS recruiter_mail_accounts_sub_idx
  ON recruiter_mail_accounts (graph_subscription_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON recruiter_mail_accounts TO lexy_app;

ALTER TABLE recruiter_mail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruiter_mail_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recruiter_mail_accounts;
CREATE POLICY tenant_isolation ON recruiter_mail_accounts
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));
