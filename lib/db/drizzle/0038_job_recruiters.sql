-- 0038_job_recruiters.sql
-- Additional recruiters assigned to a work order (jobs.id).
--
-- A work order still has ONE primary/lead recruiter in jobs.assigned_recruiter_id
-- (unchanged — every existing display, reassignment and access gate keeps using
-- it). This table holds any ADDITIONAL recruiters who also work the requisition.
-- The full assigned set for a job = jobs.assigned_recruiter_id ∪ the rows here.
--
-- Access: a plain `recruiter` may see/act on a requisition (and its candidates)
-- when they are the primary recruiter OR appear in this table for that job. The
-- recruiter ownership ceiling (getRecruiterAssignedJobIds) unions this table.
--
-- tenant_id is the work order's tenant and is the RLS scope, mirroring
-- recruiter_managers (0036) so the standard tenant_isolation policy applies.
CREATE TABLE IF NOT EXISTS job_recruiters (
  id                   text PRIMARY KEY,
  tenant_id            text NOT NULL,
  job_id               text NOT NULL,
  recruiter_user_id    text NOT NULL,
  assigned_by_user_id  text,
  created_at           timestamp NOT NULL DEFAULT now()
);

-- One row per (job, recruiter) — idempotent link.
CREATE UNIQUE INDEX IF NOT EXISTS job_recruiters_uniq
  ON job_recruiters (job_id, recruiter_user_id);
CREATE INDEX IF NOT EXISTS job_recruiters_job_idx
  ON job_recruiters (job_id);
CREATE INDEX IF NOT EXISTS job_recruiters_recruiter_idx
  ON job_recruiters (recruiter_user_id);
CREATE INDEX IF NOT EXISTS job_recruiters_tenant_idx
  ON job_recruiters (tenant_id);

-- Grants for the runtime NOLOGIN role (matches 0000_rls_pilot grants).
GRANT SELECT, INSERT, UPDATE, DELETE ON job_recruiters TO lexy_app;

-- RLS — same tenant_isolation template as migrations 0021/0034/0036, scoping by
-- the work order's tenant_id so the row is visible/writable to the owning subtree.
ALTER TABLE job_recruiters ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_recruiters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_recruiters;
CREATE POLICY tenant_isolation ON job_recruiters
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));
