-- 0036_recruiter_managers_rollback.sql
-- Reverts 0036_recruiter_managers.sql.
DROP POLICY IF EXISTS tenant_isolation ON recruiter_managers;
DROP TABLE IF EXISTS recruiter_managers;
