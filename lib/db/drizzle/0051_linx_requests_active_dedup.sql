-- 0051: DB-level dedup seal for LINX requests.
-- One ACTIVE (pending/accepted) request per job, enforced by a partial
-- unique index so concurrent POSTs cannot race past the app-level check.
-- History rows (declined/filled/closed) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS linx_requests_one_active_per_job
  ON linx_requests (job_id)
  WHERE status IN ('pending', 'accepted');
