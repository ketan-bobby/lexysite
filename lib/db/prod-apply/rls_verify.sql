-- =====================================================================
-- LEXY RLS ENFORCEMENT — VERIFICATION (RUN AFTER rls_up_consolidated.sql)
-- =====================================================================
-- Proves, on REAL data, that RLS is correctly enforced. Read-only; makes
-- no changes. Run as the DB owner/admin role (the same bypass role your
-- app/background jobs use):
--
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f rls_verify.sql
--
-- WHAT EACH SECTION PROVES
-- ------------------------
-- [SCHEMA]    Catalog checks (read pg_catalog, not row data): 42 tables
--             ENABLE+FORCE, every forced table has >=1 policy, and
--             app_tenant_in_scope() exists.
--
-- [SAFE]      THE TEST THAT MATTERS — real tenant isolation. This does
--             exactly what the app does: SET ROLE lexy_app (which is NOT
--             bypassrls, so policies actually apply) and sets the tenant
--             GUCs, then confirms the session sees ONLY that tenant's rows
--             and ZERO of another tenant's. Repeated for a second tenant
--             (RESET ROLE between them). If lexy_app ever sees another
--             tenant's row, this ABORTS with an error.
--
-- [TRAP]      EXPECTED, NOT A FAILURE — the same tenant GUC is set but WITHOUT
--             SET ROLE, so the base/bypass role runs the query. It sees ALL
--             rows across every tenant. This is by design: the app's base
--             (and all background/scheduler) connections are BYPASSRLS, which
--             is why isolation ONLY holds after SET ROLE lexy_app. Seeing all
--             rows here is the point — it demonstrates why GUC-only checks
--             (no SET ROLE) are the "false-READY trap" and prove nothing.
--
-- VERDICT KEY: SAFE result (lexy_app sees only its tenant) == RLS enforced.
--              TRAP result (base role sees all)            == expected, not a bug.
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

-- --------------------------------------------------------------------
-- [SCHEMA] catalog checks (valid regardless of role; read catalog only)
-- --------------------------------------------------------------------
DO $schema$
DECLARE
  n_enabled int; n_forced int; n_both int; n_pol int; n_unpol int; n_fn int;
BEGIN
  SELECT count(*) INTO n_enabled FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE c.relkind='r' AND ns.nspname='public' AND c.relrowsecurity;
  SELECT count(*) INTO n_forced FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE c.relkind='r' AND ns.nspname='public' AND c.relforcerowsecurity;
  SELECT count(*) INTO n_both FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE c.relkind='r' AND ns.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity;
  SELECT count(*) INTO n_pol FROM pg_policies WHERE schemaname='public';
  SELECT count(*) INTO n_unpol FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE c.relkind='r' AND ns.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname);
  SELECT count(*) INTO n_fn FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
    WHERE p.proname='app_tenant_in_scope' AND ns.nspname='public';

  RAISE NOTICE '[SCHEMA] enabled=%, forced=%, enable+force=%, policies=%, unpolicied_forced=%, app_tenant_in_scope=%',
    n_enabled, n_forced, n_both, n_pol, n_unpol, n_fn;

  IF n_fn < 1 THEN RAISE EXCEPTION '[SCHEMA] FAIL: app_tenant_in_scope() is missing'; END IF;
  -- NOTE (2026-07-23): later migrations legitimately add more RLS tables
  -- (candidate_evaluations, linx_requests, ...), so the floor is >= 42.
  IF n_both < 42 THEN RAISE EXCEPTION '[SCHEMA] FAIL: expected >= 42 ENABLE+FORCE tables, found %', n_both; END IF;
  IF n_enabled <> n_both OR n_forced <> n_both THEN
    RAISE EXCEPTION '[SCHEMA] FAIL: ENABLE(%)/FORCE(%) not aligned (both=%)', n_enabled, n_forced, n_both; END IF;
  IF n_unpol <> 0 THEN RAISE EXCEPTION '[SCHEMA] FAIL: % forced table(s) have no policy', n_unpol; END IF;

  RAISE NOTICE '[SCHEMA] PASS: % tables ENABLE+FORCE, all policied, app_tenant_in_scope() present.', n_both;
END
$schema$;

-- --------------------------------------------------------------------
-- [SAFE]/[TRAP] runtime, row-level isolation on REAL data.
-- candidates is FORCE+policied and keys on tenant_id (text) — ideal probe.
-- --------------------------------------------------------------------
DO $iso$
DECLARE
  a_id text; b_id text; a_name text; b_name text;
  base_role text; is_bypass boolean;
  total bigint; a_cnt bigint; b_cnt bigint;
  visA_total bigint; visA_a bigint; visA_b bigint;
  visB_total bigint; visB_a bigint; visB_b bigint;
  trap_total bigint;
BEGIN
  SELECT current_user INTO base_role;
  SELECT rolbypassrls INTO is_bypass FROM pg_roles WHERE rolname = current_user;

  -- Pick the two tenants with the most candidate rows (as base role).
  SELECT tenant_id INTO a_id FROM candidates WHERE tenant_id IS NOT NULL
    GROUP BY tenant_id ORDER BY count(*) DESC, tenant_id LIMIT 1;
  SELECT tenant_id INTO b_id FROM candidates WHERE tenant_id IS NOT NULL AND tenant_id <> a_id
    GROUP BY tenant_id ORDER BY count(*) DESC, tenant_id LIMIT 1;
  IF a_id IS NULL OR b_id IS NULL THEN
    RAISE EXCEPTION '[ISOLATION] cannot run: need >=2 tenants with candidate rows (found a=%, b=%)', a_id, b_id;
  END IF;
  SELECT name INTO a_name FROM tenants WHERE id::text = a_id;
  SELECT name INTO b_name FROM tenants WHERE id::text = b_id;

  -- Ground truth: base (bypass) role sees everything.
  SELECT count(*) INTO total FROM candidates;
  SELECT count(*) INTO a_cnt FROM candidates WHERE tenant_id = a_id;
  SELECT count(*) INTO b_cnt FROM candidates WHERE tenant_id = b_id;
  RAISE NOTICE '[GROUND TRUTH] base role "%" (bypassrls=%) sees total=%, tenant A "%"=%, tenant B "%"=%',
    base_role, is_bypass, total, a_name, a_cnt, b_name, b_cnt;

  -- ---- [SAFE] scoped to tenant A, exactly as the app does ----
  PERFORM set_config('app.is_platform_admin', 'false', false);
  PERFORM set_config('app.current_tenant_id', a_id, false);
  PERFORM set_config('app.allowed_tenant_ids', a_id, false);
  EXECUTE 'SET ROLE lexy_app';
  EXECUTE 'SELECT count(*) FROM candidates' INTO visA_total;
  EXECUTE 'SELECT count(*) FROM candidates WHERE tenant_id = $1' INTO visA_a USING a_id;
  EXECUTE 'SELECT count(*) FROM candidates WHERE tenant_id = $1' INTO visA_b USING b_id;
  EXECUTE 'RESET ROLE';

  -- ---- [SAFE] RESET ROLE, repeat scoped to tenant B ----
  PERFORM set_config('app.current_tenant_id', b_id, false);
  PERFORM set_config('app.allowed_tenant_ids', b_id, false);
  EXECUTE 'SET ROLE lexy_app';
  EXECUTE 'SELECT count(*) FROM candidates' INTO visB_total;
  EXECUTE 'SELECT count(*) FROM candidates WHERE tenant_id = $1' INTO visB_a USING a_id;
  EXECUTE 'SELECT count(*) FROM candidates WHERE tenant_id = $1' INTO visB_b USING b_id;
  EXECUTE 'RESET ROLE';

  RAISE NOTICE '[SAFE] as lexy_app scoped to A "%": visible=% (own A=%, of B=%) — expected %/%/0',
    a_name, visA_total, visA_a, visA_b, a_cnt, a_cnt;
  RAISE NOTICE '[SAFE] as lexy_app scoped to B "%": visible=% (own B=%, of A=%) — expected %/%/0',
    b_name, visB_total, visB_b, visB_a, b_cnt, b_cnt;

  IF NOT (visA_total = a_cnt AND visA_a = a_cnt AND visA_b = 0) THEN
    RAISE EXCEPTION '[SAFE] FAIL: tenant A leak — visible=% own=% ofB=% (expected %/%/0). RLS NOT isolating.',
      visA_total, visA_a, visA_b, a_cnt, a_cnt;
  END IF;
  IF NOT (visB_total = b_cnt AND visB_b = b_cnt AND visB_a = 0) THEN
    RAISE EXCEPTION '[SAFE] FAIL: tenant B leak — visible=% own=% ofA=% (expected %/%/0). RLS NOT isolating.',
      visB_total, visB_b, visB_a, b_cnt, b_cnt;
  END IF;
  RAISE NOTICE '[SAFE] PASS: via SET ROLE lexy_app each tenant sees ONLY its own rows; 0 cross-tenant. RLS ENFORCED.';

  -- ---- [TRAP] base role WITH tenant-A GUC but NO SET ROLE ----
  PERFORM set_config('app.current_tenant_id', a_id, false);
  PERFORM set_config('app.allowed_tenant_ids', a_id, false);
  SELECT count(*) INTO trap_total FROM candidates;   -- runs as base (bypass) role
  RAISE NOTICE '[TRAP] EXPECTED (NOT A FAILURE): base role "%" (bypassrls=%) WITH tenant-A GUC but NO SET ROLE sees total=% (= ALL % rows). Policies do NOT apply to a bypass role — this is why the app MUST SET ROLE lexy_app, and why a GUC-only check would falsely look "isolated".',
    base_role, is_bypass, trap_total, total;

  IF is_bypass AND trap_total <> total THEN
    RAISE WARNING '[TRAP] unexpected: bypass base role saw %/% rows — investigate.', trap_total, total;
  END IF;
  IF NOT is_bypass THEN
    RAISE WARNING '[TRAP] the role running this script is NOT bypassrls. On prod the app/background role MUST be bypassrls or scheduler/public jobs will be denied. Re-run this as the app''s base role to validate the trap.';
  END IF;

  -- clear GUCs
  PERFORM set_config('app.current_tenant_id', '', false);
  PERFORM set_config('app.allowed_tenant_ids', '', false);

  RAISE NOTICE '=== VERDICT: SAFE (lexy_app sees only its tenant) proves RLS is enforced. TRAP (base role sees all) is expected by design. ===';
END
$iso$;

COMMIT;
