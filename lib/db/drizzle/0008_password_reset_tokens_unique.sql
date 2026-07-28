-- ============================================================================
-- 0008 — password_reset_tokens: enforce one active token per user (DB-level)
-- ============================================================================
--
-- Hardens the concurrency guarantee around makeResetToken(). The app-level
-- advisory lock prevents the race in normal operation, but this partial
-- unique index is the durable, race-proof invariant: at most one unused
-- token per user can exist in the table regardless of code paths.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_one_active_per_user_idx
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL;
