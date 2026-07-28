-- 0034_recruiter_admin_rollback.sql
-- Reverses 0034_recruiter_admin.sql (the recruiter_admin_clients table + RLS).
--
-- NOTE: PostgreSQL cannot DROP a single value from an enum, so the
-- `recruiter_admin` user_role value added by 0034 is intentionally NOT removed
-- here. Any users carrying that role must be reassigned BEFORE relying on this
-- rollback; the leftover enum value is inert if unused.
DROP POLICY IF EXISTS tenant_isolation ON recruiter_admin_clients;
DROP TABLE IF EXISTS recruiter_admin_clients;
