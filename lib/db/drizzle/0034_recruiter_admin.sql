-- 0034_recruiter_admin.sql
-- Task #43 — Recruiter Admin role + client-based scoping.
--
-- 1. Add the `recruiter_admin` value to the user_role enum. Appended LAST to
--    match the Drizzle schema array ordering (lib/db/src/schema/users.ts).
--    ALTER TYPE ... ADD VALUE cannot run inside the same transaction that uses
--    the new value; this migration never uses it, so it is safe to batch.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'recruiter_admin';

-- 2. recruiter_admin_clients — maps a recruiter_admin user to the client
--    sub-tenants they manage. `tenant_id` is the AGENCY (parent) tenant and is
--    the RLS scope (app_tenant_in_scope), mirroring every other tenant table.
CREATE TABLE IF NOT EXISTS recruiter_admin_clients (
  id                       text PRIMARY KEY,
  tenant_id                text NOT NULL,
  recruiter_admin_user_id  text NOT NULL,
  client_tenant_id         text NOT NULL,
  assigned_by_user_id      text,
  created_at               timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recruiter_admin_clients_uniq
  ON recruiter_admin_clients (recruiter_admin_user_id, client_tenant_id);
CREATE INDEX IF NOT EXISTS recruiter_admin_clients_user_idx
  ON recruiter_admin_clients (recruiter_admin_user_id);
CREATE INDEX IF NOT EXISTS recruiter_admin_clients_tenant_idx
  ON recruiter_admin_clients (tenant_id);

-- 3. Grants for the runtime NOLOGIN role (matches 0000_rls_pilot grants).
GRANT SELECT, INSERT, UPDATE, DELETE ON recruiter_admin_clients TO lexy_app;

-- 4. RLS — same tenant_isolation template as migration 0021, scoping by the
--    agency tenant_id so the row is visible/writable to the owning subtree.
ALTER TABLE recruiter_admin_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruiter_admin_clients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recruiter_admin_clients;
CREATE POLICY tenant_isolation ON recruiter_admin_clients
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));
