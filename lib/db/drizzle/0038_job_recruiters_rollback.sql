-- 0038_job_recruiters_rollback.sql
DROP POLICY IF EXISTS tenant_isolation ON job_recruiters;
DROP TABLE IF EXISTS job_recruiters;
