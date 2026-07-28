-- 0044_morning_report_last_seen_rollback.sql
-- Reverses 0044_morning_report_last_seen.sql.

ALTER TABLE public.users
  DROP COLUMN IF EXISTS last_report_seen_at;
