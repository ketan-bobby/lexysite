-- ============================================================================
-- 0045 — http_access_logs table (durable pino-http access-log sink)
-- ============================================================================
--
-- One row per completed HTTP request, written fire-and-forget from
-- lib/http-access-log.ts on the response `finish` event. This is the durable
-- destination for the pino-http access log because the hosting platform offers
-- no genuine log drain.
--
-- Captured: method, registered route pattern (NULL for unmatched requests --
-- never derived from the raw URL / querystring), status code, response time
-- (ms), client ip, resolved user_id/tenant_id (nullable), and the pino
-- request_id. Deliberately NOT captured: request bodies, tokens, auth headers,
-- query strings, and the raw request URL/path.
--
-- NOT RLS-protected: this is a platform-operations surface, not tenant data.
-- tenant_id is informational only. Inserts go through dbAdmin (BYPASSRLS); no
-- tenant-facing route ever reads this table raw (see SECURITY_PATTERNS.md).
--
-- Retention: pruned after 30 days by the daily http-access-log retention
-- scheduler.
-- ============================================================================

CREATE TABLE IF NOT EXISTS http_access_logs (
  id               TEXT PRIMARY KEY,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  method           TEXT NOT NULL,
  route_pattern    TEXT,
  status_code      INTEGER NOT NULL,
  response_time_ms INTEGER,
  ip               TEXT,
  user_id          TEXT,
  tenant_id        TEXT,
  request_id       TEXT
);

CREATE INDEX IF NOT EXISTS http_access_logs_occurred_at_idx
  ON http_access_logs (occurred_at DESC);

CREATE INDEX IF NOT EXISTS http_access_logs_status_occurred_idx
  ON http_access_logs (status_code, occurred_at DESC);

CREATE INDEX IF NOT EXISTS http_access_logs_route_occurred_idx
  ON http_access_logs (route_pattern, occurred_at DESC);

/* RLS intentionally NOT enabled — see header comment. This is a platform-ops
 * diagnostic surface written via the BYPASSRLS admin pool and never read by a
 * tenant-facing route. */
