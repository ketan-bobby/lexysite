-- 0020_user_status.sql
-- Add an admin-controlled account state to users.
--
-- A suspended user cannot sign in (both /auth/login and /auth/candidate-login
-- return 403 ACCOUNT_SUSPENDED). Lockout (failed_login_attempts /
-- locked_until) is automatic and time-bounded; status is an explicit
-- admin action that persists until an admin reactivates the account.
--
-- Defaults to 'active' so the backfill of existing rows is trivial and
-- no user is accidentally locked out by this migration.

DO $$ BEGIN
  CREATE TYPE public.user_status AS ENUM ('active', 'suspended');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS status public.user_status NOT NULL DEFAULT 'active';
