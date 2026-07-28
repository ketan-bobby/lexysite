-- 2026-05-14 Current-employee sourcing
-- Mark candidates that are current employees of the tenant (e.g. via HRIS sync)
-- so the sourcing engine can ALWAYS surface them regardless of which external
-- sources the recruiter has enabled.
--
-- Idempotent.

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS is_current_employee BOOLEAN NOT NULL DEFAULT false;

-- Lets the internal-sourcing query cheaply pull all employees for a tenant,
-- and lets reports filter "employees only" without a full table scan.
CREATE INDEX IF NOT EXISTS idx_candidates_tenant_employee
  ON candidates (tenant_id, is_current_employee)
  WHERE is_current_employee = true;
