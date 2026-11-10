-- Apply to the identity/control database before deploying session revocation.
-- No raw tokens, user data or tenant data are retained.
CREATE TABLE auth_session_revocations (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_session_revocations_expiry ON auth_session_revocations(expires_at);
REVOKE ALL ON auth_session_revocations FROM PUBLIC;
