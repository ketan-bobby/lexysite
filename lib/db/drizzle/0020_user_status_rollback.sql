-- 0020_user_status_rollback.sql
-- Reverse 0020_user_status.sql.
--
-- Dropping the column also drops any 'suspended' state — suspended users
-- will be able to sign in again after rollback. Confirm that's intended
-- before running this in any environment with real users.

ALTER TABLE public.users
  DROP COLUMN IF EXISTS status;

DROP TYPE IF EXISTS public.user_status;
