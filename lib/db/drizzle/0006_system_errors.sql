-- ============================================================================
-- 0006 — system_errors table (self-hosted error tracking)
-- ============================================================================
--
-- Persistent log of every runtime crash captured by the api-server's global
-- error handler (Express 5xx), process-level handlers (uncaughtException,
-- unhandledRejection), and any scheduler / manual `captureError()` call.
--
-- NOT RLS-protected: this is a platform-admin diagnostic surface, not
-- tenant data. tenantId is informational only. Reads are gated at the
-- route layer (/api/admin/system-errors → platform_admin only).
--
-- Fire-and-forget inserts from lib/error-tracking.ts go through dbAdmin
-- (BYPASSRLS) so capture still works from a fail-closed request context.
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_errors (
  id           TEXT PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL,
  status_code  INTEGER,
  method       TEXT,
  route_path   TEXT,
  error_name   TEXT,
  message      TEXT NOT NULL,
  stack        TEXT,
  tenant_id    TEXT,
  user_id      TEXT,
  request_id   TEXT,
  extra        JSONB
);

CREATE INDEX IF NOT EXISTS system_errors_occurred_at_idx
  ON system_errors (occurred_at DESC);

CREATE INDEX IF NOT EXISTS system_errors_source_occurred_idx
  ON system_errors (source, occurred_at DESC);

CREATE INDEX IF NOT EXISTS system_errors_route_occurred_idx
  ON system_errors (route_path, occurred_at DESC);

/* RLS intentionally NOT enabled — see header comment. The whole point is
 * that platform_admin can see every tenant's errors in one query. */
