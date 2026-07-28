-- 0036_recruiter_managers.sql
-- Recruiter → Recruiter Admin reporting links.
--
-- recruiter_managers — maps a `recruiter` user to the `recruiter_admin` user(s)
-- they report to. Many-to-many: a recruiter may report to multiple admins, and
-- an admin may have many recruiters. `tenant_id` is the AGENCY (parent) tenant
-- and is the RLS scope (app_tenant_in_scope), mirroring recruiter_admin_clients
-- (migration 0034).
CREATE TABLE IF NOT EXISTS recruiter_managers (
  id                       text PRIMARY KEY,
  tenant_id                text NOT NULL,
  recruiter_user_id        text NOT NULL,
  recruiter_admin_user_id  text NOT NULL,
  assigned_by_user_id      text,
  created_at               timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recruiter_managers_uniq
  ON recruiter_managers (recruiter_user_id, recruiter_admin_user_id);
CREATE INDEX IF NOT EXISTS recruiter_managers_recruiter_idx
  ON recruiter_managers (recruiter_user_id);
CREATE INDEX IF NOT EXISTS recruiter_managers_admin_idx
  ON recruiter_managers (recruiter_admin_user_id);
CREATE INDEX IF NOT EXISTS recruiter_managers_tenant_idx
  ON recruiter_managers (tenant_id);

-- Grants for the runtime NOLOGIN role (matches 0000_rls_pilot grants).
GRANT SELECT, INSERT, UPDATE, DELETE ON recruiter_managers TO lexy_app;

-- RLS — same tenant_isolation template as migration 0021/0034, scoping by the
-- agency tenant_id so the row is visible/writable to the owning subtree.
ALTER TABLE recruiter_managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruiter_managers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recruiter_managers;
CREATE POLICY tenant_isolation ON recruiter_managers
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));
