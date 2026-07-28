-- Rollback for 2026-05-14-current-employee-sourcing.sql
DROP INDEX IF EXISTS idx_candidates_tenant_employee;
ALTER TABLE candidates DROP COLUMN IF EXISTS is_current_employee;
