-- 0044_morning_report_last_seen.sql
-- Add LAST_REPORT_SEEN_AT to users for the dashboard "Morning Report" feature.
--
-- The Morning Report summarizes activity SINCE this timestamp ("since when").
-- NULL means the user has never seen a report (first-ever visit → the "welcome"
-- variant). The column is advanced when the user dismisses / next sees the
-- report (POST /analytics/morning-report/seen). It is pure report bookkeeping —
-- it does not change any run, count, queue, or their definitions.
--
-- Nullable with NO default: existing users backfill to NULL (treated as a first
-- visit). Plain column on the already-RLS-scoped users table (tenant_id + the
-- tenant-isolation policy/grants from earlier migrations), so — like migration
-- 0042 — there is no RLS policy / grant / FK change.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_report_seen_at timestamp;
