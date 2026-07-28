-- ============================================================================
-- 0007 — password_reset_tokens table (single-use reset tokens)
-- ============================================================================
--
-- Replaces the previous stateless HMAC-only reset tokens with a DB-backed
-- single-use design. Issuing a token inserts a row; redeeming marks used_at
-- atomically so the same token cannot be replayed even within the TTL.
--
-- Only the SHA-256 hash of the raw token is stored; the raw token only ever
-- exists in the user's email. A read-only DB compromise therefore cannot be
-- used to reset any user's password.
--
-- NOT RLS-protected: rows are written/read by the public auth flow, keyed by
-- token hash (which is unguessable). Access goes through the api-server's
-- non-RLS client.
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_ip   TEXT
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id);
