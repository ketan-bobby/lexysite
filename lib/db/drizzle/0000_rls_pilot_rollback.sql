-- Rollback for 0000_rls_pilot.sql. Run this if RLS causes a production
-- incident and you need to restore pre-pilot behaviour quickly.
--
-- Order matters: drop policies first, then disable RLS, then revoke grants,
-- then drop the role. (Dropping a role that still owns grants fails.)

DROP POLICY IF EXISTS tenant_isolation ON candidates;
DROP POLICY IF EXISTS tenant_isolation ON applications;
DROP POLICY IF EXISTS tenant_isolation ON interview_sessions;

ALTER TABLE candidates         DISABLE ROW LEVEL SECURITY;
ALTER TABLE applications       DISABLE ROW LEVEL SECURITY;
ALTER TABLE interview_sessions DISABLE ROW LEVEL SECURITY;

ALTER TABLE candidates         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE applications       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE interview_sessions NO FORCE ROW LEVEL SECURITY;

-- Revoke everything we granted, then revoke the default-privilege rules.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM lexy_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM lexy_app;
REVOKE ALL ON SCHEMA public                  FROM lexy_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES   FROM lexy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT                  ON SEQUENCES FROM lexy_app;

DROP ROLE IF EXISTS lexy_app;
