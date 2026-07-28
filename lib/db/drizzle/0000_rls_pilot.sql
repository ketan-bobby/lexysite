-- ============================================================================
-- RLS Pilot — candidates, applications, interview_sessions
-- ============================================================================
--
-- Goal: defense-in-depth tenant isolation. Even if a route handler forgets
-- a `WHERE tenant_id = ?` clause, Postgres itself will refuse to return
-- rows from another tenant.
--
-- How it works:
--   1. A new NOLOGIN role `lexy_app` is created. The application's HTTP
--      middleware (withTenantContext) acquires a connection as the existing
--      `postgres` superuser, then issues `SET ROLE lexy_app` so subsequent
--      queries on that connection run under a role that DOES NOT bypass RLS.
--   2. The middleware also sets two GUCs on that connection:
--        app.current_tenant_id   – the caller's tenantId from the JWT
--        app.is_platform_admin   – 'true' for platform_admin role, else 'false'
--   3. The policies below allow a row only if the row's tenant_id matches
--      app.current_tenant_id, OR the caller is a platform admin.
--   4. Schedulers, webhooks, and any code path that does NOT go through the
--      middleware continues to use the raw `postgres` connection, which has
--      BYPASSRLS — so cross-tenant background jobs still work unchanged.
--
-- Why FORCE: by default RLS does NOT apply to the table owner. Our tables
-- are owned by `postgres`. Without FORCE, a query that somehow runs as the
-- owner would silently bypass the policies. FORCE removes that escape hatch.
--
-- Rollback: see 0000_rls_pilot_rollback.sql.
-- ============================================================================

-- 1. Create the role used for per-request HTTP handlers. NOLOGIN means it
--    cannot be connected to directly; it is only ever assumed via SET ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lexy_app') THEN
    CREATE ROLE lexy_app NOLOGIN;
  END IF;
END$$;

-- 2. Grants. lexy_app needs CRUD on every table, USAGE on sequences for
--    SERIAL/IDENTITY inserts, and USAGE on the schema itself.
GRANT USAGE ON SCHEMA public TO lexy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO lexy_app;
GRANT USAGE, SELECT                 ON ALL SEQUENCES IN SCHEMA public TO lexy_app;

-- Future-proof: tables created after this migration automatically get the
-- same grants without re-running this script.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES   TO lexy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                 ON SEQUENCES TO lexy_app;

-- 3. Enable + FORCE RLS on the 3 pilot tables. After this point, any query
--    against these tables that is NOT made by a BYPASSRLS role (i.e. NOT
--    postgres/superuser) MUST satisfy a policy below.
ALTER TABLE candidates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates         FORCE  ROW LEVEL SECURITY;
ALTER TABLE applications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications       FORCE  ROW LEVEL SECURITY;
ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_sessions FORCE  ROW LEVEL SECURITY;

-- 4. Policies. One per table; identical shape.
--
--    USING       — rows visible to SELECT/UPDATE/DELETE
--    WITH CHECK  — rows allowed by INSERT/UPDATE
--
--    current_setting(name, true) returns NULL when the GUC is unset (the
--    second arg makes it "missing-ok"). NULL comparisons are NULL → false,
--    so a query made under lexy_app WITHOUT a tenant context returns ZERO
--    rows. That is the safe default: failure mode is "no data" rather than
--    "all data".
--
--    tenant_id is `text` (not uuid) in this schema, so no cast is needed.

CREATE POLICY tenant_isolation ON candidates
  FOR ALL
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON applications
  FOR ALL
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON interview_sessions
  FOR ALL
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  );
