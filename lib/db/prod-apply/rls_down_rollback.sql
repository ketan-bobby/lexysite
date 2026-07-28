-- =====================================================================
-- LEXY RLS ENFORCEMENT — DOWN / ROLLBACK (RETURN PROD TO RLS-OFF)
-- =====================================================================
-- Reverses rls_up_consolidated.sql. Returns production to a non-enforcing,
-- RLS-off state (functionally identical to prod before the UP was applied):
--   * every policy in schema `public` is dropped,
--   * ROW LEVEL SECURITY is DISABLED and NO FORCE on every public table.
--
-- WHAT IS INTENTIONALLY LEFT IN PLACE (matches prod's pre-UP state):
--   * The app_tenant_in_scope() function — it already existed in prod
--     before the UP and is completely inert once no policy references it.
--   * The lexy_app role and its table grants — these already existed in
--     prod before the UP; without any policies they impose no restriction.
--   Dropping them is unnecessary for RLS-off and would be riskier, so we
--   don't. (If you ever want a full teardown, drop them manually.)
--
-- HOW TO RUN (as the DB owner / superuser, NOT drizzle-kit):
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f rls_down_rollback.sql
--
-- ATOMICITY: everything runs inside ONE transaction. If ANY statement
-- fails (including the verification block), the ENTIRE rollback rolls
-- back and prod stays exactly as it was. No half-rolled-back outcome.
--
-- Expected end state: 0 tables RLS-enabled, 0 tables RLS-forced,
-- 0 policies in `public`. The in-transaction verification asserts this.
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

-- 1) Drop every Row-Level-Security policy in schema `public`.
DO $drop_policies$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
     ORDER BY tablename, policyname
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;
END
$drop_policies$;

-- 2) Disable + un-force RLS on every table in schema `public`.
DO $disable_rls$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ns.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND ns.nspname = 'public'
       AND (c.relrowsecurity OR c.relforcerowsecurity)
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', r.nspname, r.relname);
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.nspname, r.relname);
  END LOOP;
END
$disable_rls$;

-- =====================================================================
-- IN-TRANSACTION VERIFICATION (all-or-nothing).
-- Aborts the rollback if RLS is not fully off.
-- =====================================================================
DO $verify$
DECLARE
  n_enabled  int;
  n_forced   int;
  n_policies int;
BEGIN
  SELECT count(*) INTO n_enabled
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relkind = 'r' AND ns.nspname = 'public' AND c.relrowsecurity;

  SELECT count(*) INTO n_forced
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relkind = 'r' AND ns.nspname = 'public' AND c.relforcerowsecurity;

  SELECT count(*) INTO n_policies
    FROM pg_policies WHERE schemaname = 'public';

  RAISE NOTICE 'RLS rollback verification: enabled=%, forced=%, policies=%',
    n_enabled, n_forced, n_policies;

  IF n_enabled <> 0 OR n_forced <> 0 OR n_policies <> 0 THEN
    RAISE EXCEPTION 'RLS rollback FAILED (rolling back): expected 0/0/0, got enabled=%, forced=%, policies=%',
      n_enabled, n_forced, n_policies;
  END IF;

  RAISE NOTICE 'RLS rollback PASSED: 0 enabled, 0 forced, 0 policies. Committing.';
END
$verify$;

COMMIT;

-- =====================================================================
-- POST-COMMIT PROOF (read-only; prints the committed RLS-off state)
-- =====================================================================
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE c.relkind='r' AND ns.nspname='public' AND c.relrowsecurity)         AS tables_rls_enabled,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE c.relkind='r' AND ns.nspname='public' AND c.relforcerowsecurity)     AS tables_rls_forced,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public')                   AS total_policies;
