-- =====================================================================
-- LEXY RLS ENFORCEMENT — CONSOLIDATED UP MIGRATION (PRODUCTION APPLY)
-- =====================================================================
-- Generated from the EXACT migration set proven in the final dress
-- rehearsal against a restore of REAL production data.
--
-- Migration order (byte-identical to the rehearsal, concatenated in this
-- order with no edits to any statement):
--   0000_rls_pilot
--   0001_rls_extension
--   0003_rls_extension_fix
--   0004_rls_carveouts_bespoke
--   0005_users_tenant_idx_and_cae_tighten
--   0021_rls_parent_child_subtree
--   0034_recruiter_admin
--   0035_recruiter_mail_accounts
--   0036_recruiter_managers
--   0037_recruiter_managers_per_workorder
--   0038_job_recruiters
--   0039_agent_runs
--   0043_pipeline_run_events
--
-- HOW TO RUN (as the DB owner / superuser, NOT drizzle-kit):
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f rls_up_consolidated.sql
--
-- ATOMICITY: everything runs inside ONE transaction. If ANY statement
-- fails (including the verification block at the end), the ENTIRE
-- migration rolls back and prod stays exactly in its current state.
-- There is no half-migrated outcome.
--
-- Expected end state (proven on real prod data): 42 tables ENABLE+FORCE,
-- 48 policies, app_tenant_in_scope() present, 0 forced tables left
-- unpolicied. The in-transaction verification block below asserts this
-- CATALOG state and aborts (rolls back) if it does not match.
--
-- NOTE: this in-transaction check is CATALOG-level only (it reads
-- pg_class/pg_policies/pg_proc, not row data). For the runtime, row-level
-- proof that tenants are actually ISOLATED — i.e. that `SET ROLE lexy_app`
-- + tenant GUCs really returns only one tenant's rows — run the companion
-- script AFTER this one:
--     psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f rls_verify.sql
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;



-- =====================================================================
-- BEGIN 0000_rls_pilot.sql
-- =====================================================================
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

-- ----- END 0000_rls_pilot.sql -----


-- =====================================================================
-- BEGIN 0001_rls_extension.sql
-- =====================================================================
-- ============================================================================
-- RLS Extension — Phase A of the broader tenant-isolation rollout
-- ============================================================================
--
-- Builds on 0000_rls_pilot.sql, which enabled RLS on 3 tables (candidates,
-- applications, interview_sessions) and introduced:
--   - the `lexy_app` NOLOGIN role (no BYPASSRLS)
--   - the `withTenantContext` middleware that SETs the role + GUCs
--     `app.current_tenant_id` and `app.is_platform_admin` per request
--   - the `tenant_isolation` policy template using current_setting('app.…')
--
-- This migration replicates that pattern across the remaining
-- tenant-scoped tables that are SAFE to lock down. "Safe" means: the table
-- is only ever read/written from authenticated HTTP routes that flow
-- through `withTenantContext`. Background jobs, schedulers, and webhooks
-- that legitimately need cross-tenant access continue to use `dbAdmin`,
-- which connects as the BYPASSRLS-bearing `postgres` role.
--
-- ─── Two tables use a non-standard tenant column name ───────────────────────
-- Most tables scope on `tenant_id`, but two encode the relationship in the
-- column name itself:
--   candidate_action_events.viewer_tenant_id — the tenant viewing the action
--   talent_pool_submissions.client_tenant_id  — the client tenant the
--     candidate was submitted to (talent-pool submissions are inherently
--     cross-tenant; the "owning" tenant from the receiving side is the
--     client tenant)
--
-- ⚠ POST-MERGE NOTE: code review revealed these two tables don't fit the
-- standard policy shape (viewer_tenant_id is nullable for most event
-- types; talent_pool_submissions is queried by candidate_id across
-- destinations from the recruiter side). Migration 0003_rls_extension_fix
-- backs out RLS on those two specifically, pending bespoke policies.
-- They are left here in this migration's table list for historical
-- accuracy — DO NOT delete this entry, or the rollback won't undo
-- correctly on databases where this migration ran before 0003.
--
-- ─── What's NOT covered here (Phase B / deferred) ───────────────────────────
--   users                  — login looks up by email BEFORE the tenant is
--                            known. RLS would force every login to fail.
--   tenants                — read by slug from anonymous public routes
--                            (branding lookups for candidate-facing pages).
--   invite_tokens          — accepted by token before the recipient knows
--   staff_invite_tokens      which tenant they're being invited into.
--   pending_trial_signups  — written/read during the public signup flow
--                            before a tenant exists at all.
--   partner_attribution    — partners read THEIR attribution rows across
--   partners                 every tenant they referred; RLS keyed on
--                            tenant_id would hide them.
--
-- Each of those needs a bespoke policy (e.g. a separate `app.current_partner_id`
-- GUC or per-row access keyed on something other than tenant_id). They are
-- listed here so the gap is intentional and visible, not a forgotten table.
--
-- ─── Rollback ───────────────────────────────────────────────────────────────
-- See 0001_rls_extension_rollback.sql.
-- ============================================================================

DO $$
DECLARE
  rec record;
  /* (table_name, tenant_column) pairs. Adding a new table later is a
   * one-line append. Column-name flexibility is what lets us cover
   * candidate_action_events and talent_pool_submissions cleanly. */
  tables text[][] := ARRAY[
    ['jobs',                       'tenant_id'],
    ['ideal_candidate_profiles',   'tenant_id'],
    ['outreach_campaigns',         'tenant_id'],
    ['recruiter_inbox_items',      'tenant_id'],
    ['outreach_enrollments',       'tenant_id'],
    ['outreach_messages',          'tenant_id'],
    ['talent_matches',             'tenant_id'],
    ['resume_screens',             'tenant_id'],
    ['talent_pool_submissions',    'client_tenant_id'],
    ['sourced_candidates',         'tenant_id'],
    ['candidate_notifications',    'tenant_id'],
    ['user_notifications',         'tenant_id'],
    ['communication_events',       'tenant_id'],
    ['ghosting_risk_flags',        'tenant_id'],
    ['ghosting_alerts',            'tenant_id'],
    ['nurture_pool',               'tenant_id'],
    ['interview_plans',            'tenant_id'],
    ['interview_schedules',        'tenant_id'],
    ['trust_events',               'tenant_id'],
    ['candidate_rejections',       'tenant_id'],
    ['pipeline_runs',              'tenant_id'],
    ['job_pipelines',              'tenant_id'],
    ['prep_plans',                 'tenant_id'],
    ['prep_sessions',              'tenant_id'],
    ['candidate_action_events',    'viewer_tenant_id'],
    ['tenant_decision_policies',   'tenant_id'],
    ['credit_usage_events',        'tenant_id'],
    ['candidate_import_batches',   'tenant_id'],
    ['candidate_import_records',   'tenant_id'],
    ['verification_records',       'tenant_id'],
    ['billing_invoices',           'tenant_id'],
    ['billing_subscriptions',      'tenant_id']
  ];
  tbl text;
  col text;
BEGIN
  FOR i IN 1 .. array_length(tables, 1) LOOP
    tbl := tables[i][1];
    col := tables[i][2];

    /* Enable + FORCE RLS. FORCE is required because our tables are owned
     * by `postgres`; without it, queries that somehow run as the owner
     * would silently bypass the policy. */
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tbl);

    /* Idempotent policy creation. DROP-IF-EXISTS makes this migration
     * safe to re-run (e.g. after a partial rollback). */
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING (
          current_setting('app.is_platform_admin', true) = 'true'
          OR %I = current_setting('app.current_tenant_id', true)
        )
        WITH CHECK (
          current_setting('app.is_platform_admin', true) = 'true'
          OR %I = current_setting('app.current_tenant_id', true)
        )
    $f$, tbl, col, col);
  END LOOP;
END$$;

-- ----- END 0001_rls_extension.sql -----


-- =====================================================================
-- BEGIN 0003_rls_extension_fix.sql
-- =====================================================================
-- ============================================================================
-- RLS Extension Fix — back out RLS on two tables from 0001_rls_extension.sql
-- ============================================================================
--
-- Code review of 0001 found that two tables in the Phase A list have access
-- patterns that don't fit the standard "scope by tenant_id" policy:
--
-- 1. candidate_action_events
--    The tenant column is `viewer_tenant_id`, NULLABLE, and only populated
--    for `event_type = 'recruiter_view'`. Many event types (mock interview
--    completed, role-open-at-target, profile updates from the candidate
--    portal) intentionally insert with viewer_tenant_id = NULL. Under
--    RLS, the WITH CHECK clause rejects NULL → not-equal → not platform
--    admin, so those INSERTs would 500 in production. Candidate-side
--    SELECTs by candidate_id would also return zero rows for any caller
--    whose tenantId ≠ the (often null) viewer_tenant_id.
--
-- 2. talent_pool_submissions
--    The tenant column is `client_tenant_id` — the tenant the candidate
--    is being submitted *to*. But the *recruiter* who created the
--    submission lives in a different tenant, and authenticated routes
--    in candidates.ts query this table by candidate_id (to show "X
--    companies interested in this candidate" / "last pushed at" across
--    all destinations). Scoping by client_tenant_id would silently hide
--    every submission the recruiter actually created.
--
-- Both tables need bespoke policies (e.g. allow if caller is the
-- candidate's owning tenant OR the receiving client tenant) before they
-- can be brought back under RLS. That design work is out of scope for
-- this immediate hardening pass.
--
-- The FK constraints added by 0002_tenant_id_fks.sql remain in place
-- for both tables — those are still correct (the column values do
-- reference real tenants); only the row-level policy is the wrong shape.
-- ============================================================================

DROP POLICY IF EXISTS tenant_isolation ON candidate_action_events;
ALTER TABLE candidate_action_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_action_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON talent_pool_submissions;
ALTER TABLE talent_pool_submissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE talent_pool_submissions DISABLE ROW LEVEL SECURITY;

-- ----- END 0003_rls_extension_fix.sql -----


-- =====================================================================
-- BEGIN 0004_rls_carveouts_bespoke.sql
-- =====================================================================
-- ============================================================================
-- RLS Carve-outs — bespoke policies for candidate_action_events &
-- talent_pool_submissions
-- ============================================================================
--
-- Migration 0003_rls_extension_fix.sql disabled RLS on these two tables
-- because the standard "tenant_id = current_setting('app.current_tenant_id')"
-- policy emitted by 0001 didn't fit their access patterns. This migration
-- brings them back under RLS with table-specific policies grounded in the
-- actual queries issued by the app (audit performed 2026-05-16).
--
-- ────────────────────────────────────────────────────────────────────────────
-- 1) candidate_action_events
-- ────────────────────────────────────────────────────────────────────────────
-- Schema:
--   candidate_id    text NOT NULL  -- the candidate this event is about
--   event_type      text NOT NULL  -- 'recruiter_view' | 'mock_interview_completed'
--                                  -- | 'role_open_at_target' | 'log-action' | ...
--   viewer_tenant_id text NULL    -- populated ONLY for recruiter_view events
--   payload         jsonb
--
-- Query patterns (from career-profile.ts):
--   • INSERT from 4+ event emitters; viewer_tenant_id is NULL for the
--     candidate-side event types (mock interview completed, log-action,
--     role-open-at-target). The 0001 policy rejected those INSERTs.
--   • SELECT by candidate_id filtered on event_type='recruiter_view' to
--     answer "did your tenant view this candidate" — recruiter-side reads
--     where the row's viewer_tenant_id matches the caller's tenant.
--   • SELECT by candidate_id with no viewer_tenant_id predicate — the
--     candidate's own activity feed (candidate-portal session).
--
-- Bespoke policy:
--   INSERT — allow always. This is an append-only audit log; the route-
--     level auth already authenticated the caller, and we deliberately do
--     not gate INSERTs by current_tenant_id because the legitimate
--     candidate-side emitters intentionally write viewer_tenant_id=NULL.
--   SELECT — allow when (a) platform_admin, OR (b) viewer_tenant_id IS NULL
--     (candidate-side rows: the candidate-portal handler filters by
--     candidate_id which is the real access gate), OR (c) the row's
--     viewer_tenant_id matches the caller (a recruiter looking at their
--     own viewing history). This still prevents recruiter tenant A from
--     reading recruiter tenant B's view-attribution rows, which was the
--     original cross-tenant leak.
--   UPDATE / DELETE — platform_admin only. The table is meant to be
--     immutable; mutations only happen from migration/cleanup tooling.
--
-- Known residual: NULL viewer_tenant_id rows are visible to anyone with a
--   valid tenant context. Routes that surface them MUST keep filtering by
--   candidate_id and enforcing candidate-portal authz at the app layer.
--   Tightening to "viewer_tenant_id IS NULL AND caller owns candidate_id"
--   requires a subquery into candidates and is deferred — tracked as a
--   follow-up. See RLS_PILOT.md.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE candidate_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_action_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cae_insert ON candidate_action_events;
DROP POLICY IF EXISTS cae_select ON candidate_action_events;
DROP POLICY IF EXISTS cae_update ON candidate_action_events;
DROP POLICY IF EXISTS cae_delete ON candidate_action_events;

CREATE POLICY cae_insert ON candidate_action_events
  FOR INSERT TO lexy_app
  WITH CHECK (true);

CREATE POLICY cae_select ON candidate_action_events
  FOR SELECT TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR viewer_tenant_id IS NULL
    OR viewer_tenant_id = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY cae_update ON candidate_action_events
  FOR UPDATE TO lexy_app
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY cae_delete ON candidate_action_events
  FOR DELETE TO lexy_app
  USING (current_setting('app.is_platform_admin', true) = 'true');

-- ────────────────────────────────────────────────────────────────────────────
-- 2) talent_pool_submissions
-- ────────────────────────────────────────────────────────────────────────────
-- Schema (relevant cols):
--   candidate_id        text NULL  -- populated for recruiter-pushed rows
--   client_tenant_id    text NULL  -- the tenant the candidate is pushed TO
--   pushed_by_user_id   text NULL  -- the user (in the RECRUITER tenant)
--                                     who created the push
--   <other intake fields>
--
-- Query patterns:
--   • INSERT from /public/talent-pool (intake form, dbAdmin, no auth) —
--     leaves candidate_id / client_tenant_id NULL.
--   • INSERT from candidates.ts push-to-client (recruiter tenant) — sets
--     candidate_id, client_tenant_id (DIFFERENT tenant), pushed_by_user_id.
--   • SELECT by candidate_id (candidates.ts) — recruiter answering
--     "how many clients has this candidate been pushed to". The recruiter
--     who originated the push lives in tenant X; the row's client_tenant_id
--     is tenant Y. Scoping by client_tenant_id alone would HIDE the row
--     from its own author.
--   • SELECT by client_tenant_id (candidates.ts inbox view) — the
--     receiving client tenant browses incoming submissions.
--   • SELECT by job_posting_id (jobs.ts + candidates.ts) — recruiter
--     view, same problem as candidate_id SELECT.
--
-- Bespoke policy:
--   INSERT — allow always (recruiter-side pushes legitimately write rows
--     whose client_tenant_id ≠ current_tenant_id; the public-intake path
--     uses dbAdmin and bypasses RLS entirely).
--   SELECT — allow when (a) platform_admin, OR (b) client_tenant_id IS
--     NULL (intake rows are public-by-design until processed), OR (c) the
--     row's client_tenant_id matches the caller (client-side inbox), OR
--     (d) the row's pushed_by_user_id belongs to a user in the caller's
--     tenant (recruiter-side own-push history — subquery into users,
--     which is BYPASSRLS so the lookup returns the right set).
--   UPDATE / DELETE — client_tenant_id = caller (client manages their
--     own pipeline) OR platform_admin. The recruiter who pushed cannot
--     retract the row from the client side; that intentionally matches
--     the product design ("a push is a record, not a draft").
--
-- Performance note: the pushed_by_user_id subquery hits users by
-- tenant_id. users(tenant_id) is indexed (FK + b-tree from 0001), so the
-- planner can fold this into a hashed semi-join — measured cost is
-- negligible at current row counts.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE talent_pool_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_pool_submissions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tps_insert ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_select ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_update ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_delete ON talent_pool_submissions;

CREATE POLICY tps_insert ON talent_pool_submissions
  FOR INSERT TO lexy_app
  WITH CHECK (true);

CREATE POLICY tps_select ON talent_pool_submissions
  FOR SELECT TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id IS NULL
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
    OR pushed_by_user_id IN (
      SELECT id FROM users
      WHERE tenant_id = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tps_update ON talent_pool_submissions
  FOR UPDATE TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tps_delete ON talent_pool_submissions
  FOR DELETE TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
  );

-- ----- END 0004_rls_carveouts_bespoke.sql -----


-- =====================================================================
-- BEGIN 0005_users_tenant_idx_and_cae_tighten.sql
-- =====================================================================
-- ============================================================================
-- Follow-up to 0004 — index + cae_select tightening
-- ============================================================================
--
-- Two corrections after the second architect review of the carve-out
-- policies:
--
-- 1) The `users(tenant_id)` index that 0004's tps_select policy relies on
--    via `pushed_by_user_id IN (SELECT id FROM users WHERE tenant_id = …)`
--    did NOT actually exist (despite what 0004's comment claimed). At any
--    non-trivial users row count that subquery would degrade to a seq
--    scan on every SELECT against talent_pool_submissions. Add the index.
--
-- 2) `cae_select` previously allowed `viewer_tenant_id IS NULL` for ANY
--    authenticated caller. The architect flagged this as a cross-tenant
--    read of candidate-side event rows (mock_interview_completed,
--    log-action, role_open_at_target). Tighten so NULL-viewer rows are
--    only visible to a caller whose tenant owns the referenced candidate.
--
--    The candidates table is RLS-protected (0001), and the subquery
--    inherits that — so the EXISTS only returns true when the caller's
--    standard candidates policy would have let them SELECT the candidate
--    row. This is the same access surface a recruiter already has when
--    viewing the candidate's profile elsewhere; it just stops a random
--    other tenant from enumerating candidate activity by candidate_id.
--
--    Candidate-portal flows still work: the candidate-user's `tenant_id`
--    column points at the candidate's owning tenant, so their session
--    sets the matching GUC and the EXISTS succeeds.
-- ============================================================================

CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users (tenant_id);

DROP POLICY IF EXISTS cae_select ON candidate_action_events;

CREATE POLICY cae_select ON candidate_action_events
  FOR SELECT TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR viewer_tenant_id = current_setting('app.current_tenant_id', true)
    OR (
      viewer_tenant_id IS NULL
      AND EXISTS (
        SELECT 1 FROM candidates c
        WHERE c.id = candidate_action_events.candidate_id
          AND c.tenant_id = current_setting('app.current_tenant_id', true)
      )
    )
  );

-- ----- END 0005_users_tenant_idx_and_cae_tighten.sql -----


-- =====================================================================
-- BEGIN 0021_rls_parent_child_subtree.sql
-- =====================================================================
-- ============================================================================
-- RLS Parent→Child Visibility — full descendant subtree (TEN-03)
-- ============================================================================
--
-- Problem this fixes
-- ------------------
-- Every RLS policy shipped so far (0000 pilot, 0001 extension, 0004/0005
-- bespoke carve-outs) keys row visibility on a SINGLE GUC,
-- `app.current_tenant_id` — the caller's OWN tenant. The application layer
-- (lib/tenantUtils.ts getAllowedTenantIds + the per-route duplicates) adds
-- child tenant IDs to the WHERE clause, but RLS then filters them straight
-- back out. Net effect: a parent (agency) tenant could never actually read
-- or write a child (client / branch / sub-client) tenant's rows on any
-- RLS-protected table — the WHERE clause and the policy disagreed, and the
-- policy always won.
--
-- Decision (confirmed with the product owner)
-- -------------------------------------------
--   1. FULL access — a parent admin can VIEW *and* MODIFY descendant rows
--      (both USING and WITH CHECK admit the descendant set).
--   2. ENTIRE SUBTREE — a parent sees children, grandchildren, and every
--      further descendant, not just direct children.
--
-- How it works
-- ------------
--   • withTenantContext middleware now computes the caller's full descendant
--     subtree (recursive, cycle-safe via UNION) on the still-superuser
--     connection BEFORE `SET ROLE lexy_app`, and publishes it as a new GUC:
--         app.allowed_tenant_ids  — comma-joined own + all descendant ids
--     alongside the existing app.current_tenant_id / app.is_platform_admin.
--   • A STABLE helper function app_tenant_in_scope(text) centralises the
--     membership test. It returns true when the caller is a platform admin,
--     OR the row's tenant id is a non-NULL member of app.allowed_tenant_ids.
--   • Every tenant_isolation policy (and the bespoke cae_/tps_ policies)
--     is rewritten to call app_tenant_in_scope() instead of comparing to
--     app.current_tenant_id directly.
--
-- Fail-closed
-- -----------
--   current_setting('app.allowed_tenant_ids', true) returns NULL when the
--   GUC is unset (missing-ok). NULLIF(..,'') maps the empty string to NULL.
--   string_to_array(NULL, ',') is NULL, and `x = ANY(NULL)` is NULL → false.
--   So a connection with no tenant context returns ZERO rows — same safe
--   default the pilot established.
--
-- Rollback: see 0021_rls_parent_child_subtree_rollback.sql.
-- ============================================================================

-- 1. Membership helper. STABLE because current_setting is constant within a
--    single statement. SECURITY INVOKER (default) is fine — it reads GUCs,
--    not tables.
CREATE OR REPLACE FUNCTION app_tenant_in_scope(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      row_tenant IS NOT NULL
      AND row_tenant = ANY (
        string_to_array(
          NULLIF(current_setting('app.allowed_tenant_ids', true), ''),
          ','
        )
      )
    );
$$;

GRANT EXECUTE ON FUNCTION app_tenant_in_scope(text) TO lexy_app;

-- 2. Rewrite the standard `tenant_isolation` policy on every table that uses
--    the plain `tenant_id` column. This is the 3 pilot tables (0000) plus the
--    Phase-A extension tables (0001) MINUS the two bespoke carve-outs
--    (candidate_action_events, talent_pool_submissions — handled in step 3).
--    All listed tables scope on `tenant_id`, so the loop needs no column map.
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    -- pilot (0000)
    'candidates',
    'applications',
    'interview_sessions',
    -- extension (0001), tenant_id column only
    'jobs',
    'ideal_candidate_profiles',
    'outreach_campaigns',
    'recruiter_inbox_items',
    'outreach_enrollments',
    'outreach_messages',
    'talent_matches',
    'resume_screens',
    'sourced_candidates',
    'candidate_notifications',
    'user_notifications',
    'communication_events',
    'ghosting_risk_flags',
    'ghosting_alerts',
    'nurture_pool',
    'interview_plans',
    'interview_schedules',
    'trust_events',
    'candidate_rejections',
    'pipeline_runs',
    'job_pipelines',
    'prep_plans',
    'prep_sessions',
    'tenant_decision_policies',
    'credit_usage_events',
    'candidate_import_batches',
    'candidate_import_records',
    'verification_records',
    'billing_invoices',
    'billing_subscriptions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING (app_tenant_in_scope(tenant_id))
        WITH CHECK (app_tenant_in_scope(tenant_id))
    $f$, tbl);
  END LOOP;
END$$;

-- 3. Bespoke carve-out policies, rewritten to subtree membership.

-- 3a. candidate_action_events — cae_select.
--     Preserves the NULL-viewer carve-out from 0005 (candidate-side rows are
--     only visible when the caller's subtree owns the referenced candidate),
--     but widens "owns" from own-tenant to the full subtree. recruiter_view
--     rows are visible when the row's viewer_tenant_id is in the subtree.
--     cae_insert / cae_update / cae_delete are unchanged by this migration.
DROP POLICY IF EXISTS cae_select ON candidate_action_events;
CREATE POLICY cae_select ON candidate_action_events
  FOR SELECT TO lexy_app
  USING (
    app_tenant_in_scope(viewer_tenant_id)
    OR (
      viewer_tenant_id IS NULL
      AND EXISTS (
        SELECT 1 FROM candidates c
        WHERE c.id = candidate_action_events.candidate_id
          AND app_tenant_in_scope(c.tenant_id)
      )
    )
  );

-- 3b. talent_pool_submissions — tps_select / tps_update / tps_delete.
--     client_tenant_id IS NULL (public intake, pre-processing) stays visible.
--     Recruiter-side own-push history widens from own-tenant to subtree via
--     the pushed_by_user_id subquery. tps_insert (WITH CHECK true) unchanged.
DROP POLICY IF EXISTS tps_select ON talent_pool_submissions;
CREATE POLICY tps_select ON talent_pool_submissions
  FOR SELECT TO lexy_app
  USING (
    app_tenant_in_scope(client_tenant_id)
    OR client_tenant_id IS NULL
    OR pushed_by_user_id IN (
      SELECT id FROM users WHERE app_tenant_in_scope(tenant_id)
    )
  );

DROP POLICY IF EXISTS tps_update ON talent_pool_submissions;
CREATE POLICY tps_update ON talent_pool_submissions
  FOR UPDATE TO lexy_app
  USING (app_tenant_in_scope(client_tenant_id))
  WITH CHECK (app_tenant_in_scope(client_tenant_id));

DROP POLICY IF EXISTS tps_delete ON talent_pool_submissions;
CREATE POLICY tps_delete ON talent_pool_submissions
  FOR DELETE TO lexy_app
  USING (app_tenant_in_scope(client_tenant_id));

-- ----- END 0021_rls_parent_child_subtree.sql -----


-- =====================================================================
-- BEGIN 0034_recruiter_admin.sql
-- =====================================================================
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

-- ----- END 0034_recruiter_admin.sql -----


-- =====================================================================
-- BEGIN 0035_recruiter_mail_accounts.sql
-- =====================================================================
-- 0035_recruiter_mail_accounts.sql
-- Hybrid email sending — per-recruiter Microsoft 365 / Outlook mailbox connection.
--
-- Stores an ENCRYPTED Microsoft Graph refresh token so Lexy can send "as the
-- recruiter" from their own mailbox for manual 1:1 emails + the first/approved
-- outreach step, falling back to Amazon SES when no mailbox is connected or the
-- token fails. Reply-sync columns (graph_subscription_*, graph_delta_link)
-- support pulling Outlook replies back into Lexy.
--
-- RLS: same tenant_isolation template as migration 0021/0034, scoping by the
-- recruiter's own tenant_id.

CREATE TABLE IF NOT EXISTS recruiter_mail_accounts (
  id                            text PRIMARY KEY,
  tenant_id                     text NOT NULL,
  user_id                       text NOT NULL,
  provider                      text NOT NULL DEFAULT 'microsoft',
  email                         text NOT NULL DEFAULT '',
  home_account_id               text,
  refresh_token_enc             text,
  scopes                        text NOT NULL DEFAULT '',
  status                        text NOT NULL DEFAULT 'connected',
  last_error                    text,
  graph_subscription_id         text,
  graph_subscription_expires_at timestamp,
  graph_delta_link              text,
  connected_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                    timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recruiter_mail_accounts_user_uniq
  ON recruiter_mail_accounts (user_id);
CREATE INDEX IF NOT EXISTS recruiter_mail_accounts_tenant_idx
  ON recruiter_mail_accounts (tenant_id);
CREATE INDEX IF NOT EXISTS recruiter_mail_accounts_sub_idx
  ON recruiter_mail_accounts (graph_subscription_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON recruiter_mail_accounts TO lexy_app;

ALTER TABLE recruiter_mail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruiter_mail_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recruiter_mail_accounts;
CREATE POLICY tenant_isolation ON recruiter_mail_accounts
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

-- ----- END 0035_recruiter_mail_accounts.sql -----


-- =====================================================================
-- BEGIN 0036_recruiter_managers.sql
-- =====================================================================
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

-- ----- END 0036_recruiter_managers.sql -----


-- =====================================================================
-- BEGIN 0037_recruiter_managers_per_workorder.sql
-- =====================================================================
-- 0037_recruiter_managers_per_workorder.sql
-- Add per-work-order scoping to recruiter → recruiter-admin reporting links.
--
-- A NULL job_id row is the recruiter's DEFAULT reporting (unchanged behaviour).
-- A row with job_id set is a per-work-order OVERRIDE (jobs.id), so reporting can
-- differ for each individual work order. RLS (tenant_isolation on tenant_id) is
-- unchanged — the new column does not affect row scoping.

ALTER TABLE recruiter_managers
  ADD COLUMN IF NOT EXISTS job_id text;

-- Replace the (recruiter, admin) unique index with one that also keys on the
-- work order. COALESCE(job_id,'') keeps NULL (default) rows de-duplicated too,
-- since Postgres treats NULLs as distinct in a plain unique index.
DROP INDEX IF EXISTS recruiter_managers_uniq;
CREATE UNIQUE INDEX recruiter_managers_uniq
  ON recruiter_managers (recruiter_user_id, recruiter_admin_user_id, COALESCE(job_id, ''));

CREATE INDEX IF NOT EXISTS recruiter_managers_job_idx
  ON recruiter_managers (job_id);

-- ----- END 0037_recruiter_managers_per_workorder.sql -----


-- =====================================================================
-- BEGIN 0038_job_recruiters.sql
-- =====================================================================
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

-- ----- END 0038_job_recruiters.sql -----


-- =====================================================================
-- BEGIN 0039_agent_runs.sql
-- =====================================================================
-- 0039_agent_runs.sql
-- Agent Run event model — the audit log of autonomous agent activity.
--
-- An AgentRun (currently agent_type = 'sourcing') owns an ordered stream of
-- agent_run_events. The recruiter UI polls a run's events and renders live
-- progress; real pipeline runs and simulated demo runs write to the SAME tables
-- so the frontend has one stable contract. Runs + events persist forever.
--
-- RLS: same tenant_isolation template as migration 0021/0034/0035 — scoped by
-- tenant_id via app_tenant_in_scope(). Background writers use the BYPASSRLS
-- admin role and always set tenant_id explicitly.

CREATE TABLE IF NOT EXISTS agent_runs (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  work_order_id text NOT NULL,
  agent_type    text NOT NULL DEFAULT 'sourcing',
  status        text NOT NULL DEFAULT 'queued',
  is_simulated  boolean NOT NULL DEFAULT false,
  triggered_by  text NOT NULL DEFAULT 'user',
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  started_at    timestamp,
  completed_at  timestamp,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_work_order_idx ON agent_runs (work_order_id);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_idx ON agent_runs (tenant_id);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  run_id     text NOT NULL,
  seq        integer NOT NULL,
  type       text NOT NULL,
  step_name  text,
  message    text NOT NULL,
  count      integer,
  payload    jsonb,
  timestamp  timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE so the per-run sequence is gap-tolerant but never duplicated — the
-- polling client pages by seq, so a duplicate seq would silently drop an event.
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_events_run_seq_idx ON agent_run_events (run_id, seq);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs TO lexy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_run_events TO lexy_app;

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_runs;
CREATE POLICY tenant_isolation ON agent_runs
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

ALTER TABLE agent_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_run_events;
CREATE POLICY tenant_isolation ON agent_run_events
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

-- ----- END 0039_agent_runs.sql -----


-- =====================================================================
-- BEGIN 0043_pipeline_run_events.sql
-- =====================================================================
-- 0043_pipeline_run_events.sql
-- Persisted event stream for orchestrator PIPELINE runs (pipeline_runs) — the
-- durable counterpart to the in-memory orchestrator event buffer, which is lost
-- on every deploy. Mirrors the agent_runs event model (migration 0039):
-- tenant_id + FORCE RLS, ordered per-run `seq`, best-effort background writes via
-- the BYPASSRLS admin role which ALWAYS sets tenant_id explicitly.
--
-- A pipeline_run is the PARENT (one row per full multi-agent run); its events are
-- the per-stage lifecycle: run_started, step_started/step_completed per agent,
-- run_completed / run_failed / run_interrupted. The parent's `stages` jsonb is
-- KEPT as the Kanban's fast snapshot; this table is the additive audit trail.
--
-- ── run_activity_events view ─────────────────────────────────────────────────
-- The ONLY sanctioned read surface for CROSS-RUN activity. It normalizes the two
-- event streams (agent_run_events + pipeline_run_events) into one shape so
-- consumers never care which physical table an event came from. If the two run
-- models are ever unified (see docs/adr/0001-pipeline-run-events.md), this view
-- is the seam: consumers reading it will not need to change.

CREATE TABLE IF NOT EXISTS pipeline_run_events (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  run_id     text NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  type       text NOT NULL,
  step_name  text,
  message    text NOT NULL,
  count      integer,
  payload    jsonb,
  timestamp  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_run_events_run_seq_idx ON pipeline_run_events (run_id, seq);
CREATE INDEX IF NOT EXISTS pipeline_run_events_tenant_idx ON pipeline_run_events (tenant_id);
CREATE INDEX IF NOT EXISTS pipeline_run_events_timestamp_idx ON pipeline_run_events ("timestamp");

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_run_events TO lexy_app;

-- Tenant isolation identical to agent_run_events (migration 0039): FORCE so even
-- the table owner is scoped; app_tenant_in_scope() reads the request's tenant GUC.
ALTER TABLE pipeline_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_run_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pipeline_run_events;
CREATE POLICY tenant_isolation ON pipeline_run_events
  FOR ALL
  TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

-- Normalized cross-run activity read surface. security_invoker=true so RLS on the
-- underlying tables is enforced against the QUERYING role, not the view owner.
CREATE OR REPLACE VIEW run_activity_events
  WITH (security_invoker = true) AS
    SELECT run_id, 'agent'::text    AS run_type, tenant_id,
           type AS event_type, step_name, message, count, payload, "timestamp", seq
      FROM agent_run_events
    UNION ALL
    SELECT run_id, 'pipeline'::text AS run_type, tenant_id,
           type AS event_type, step_name, message, count, payload, "timestamp", seq
      FROM pipeline_run_events;

GRANT SELECT ON run_activity_events TO lexy_app;

COMMENT ON VIEW run_activity_events IS
  'SANCTIONED read surface for cross-run activity. Normalizes agent_run_events + pipeline_run_events into a single shape (run_id, run_type, tenant_id, event_type, timestamp, message, payload, step_name, count, seq). Do NOT read the underlying event tables directly for cross-run activity — read this view so consumers stay decoupled from which table an event lives in. Rationale + the deferred full-unification decision: docs/adr/0001-pipeline-run-events.md.';

-- ----- END 0043_pipeline_run_events.sql -----


-- =====================================================================
-- IN-TRANSACTION VERIFICATION (all-or-nothing).
-- Aborts the whole migration if the proven end-state is not reached.
-- =====================================================================
DO $verify$
DECLARE
  n_enabled  int;
  n_forced   int;
  n_both     int;
  n_policies int;
  n_unpol    int;
  n_fn       int;
BEGIN
  SELECT count(*) INTO n_enabled
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relkind = 'r' AND ns.nspname = 'public' AND c.relrowsecurity;

  SELECT count(*) INTO n_forced
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relkind = 'r' AND ns.nspname = 'public' AND c.relforcerowsecurity;

  SELECT count(*) INTO n_both
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relkind = 'r' AND ns.nspname = 'public'
     AND c.relrowsecurity AND c.relforcerowsecurity;

  SELECT count(*) INTO n_policies
    FROM pg_policies WHERE schemaname = 'public';

  SELECT count(*) INTO n_unpol
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relkind = 'r' AND ns.nspname = 'public'
     AND c.relrowsecurity AND c.relforcerowsecurity
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname);

  SELECT count(*) INTO n_fn
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE p.proname = 'app_tenant_in_scope' AND ns.nspname = 'public';

  RAISE NOTICE 'RLS verification: enabled=%, forced=%, enable+force=%, policies=%, unpolicied_forced=%, app_tenant_in_scope=%',
    n_enabled, n_forced, n_both, n_policies, n_unpol, n_fn;

  IF n_fn < 1 THEN
    RAISE EXCEPTION 'RLS verification FAILED (rolling back): app_tenant_in_scope() is missing';
  END IF;
  -- NOTE (2026-07-23): originally a fixed `= 42` check, calibrated to the
  -- dress-rehearsal snapshot. Later migrations legitimately add MORE
  -- RLS-covered tables (e.g. candidate_evaluations, linx_requests), so the
  -- invariant is now: at least the proven 42, ENABLE/FORCE aligned, and no
  -- forced table left unpolicied (the dangerous half-state).
  IF n_both < 42 THEN
    RAISE EXCEPTION 'RLS verification FAILED (rolling back): expected >= 42 ENABLE+FORCE tables, found %', n_both;
  END IF;
  IF n_enabled <> n_both OR n_forced <> n_both THEN
    RAISE EXCEPTION 'RLS verification FAILED (rolling back): ENABLE(%)/FORCE(%) not aligned (both=%)', n_enabled, n_forced, n_both;
  END IF;
  IF n_unpol <> 0 THEN
    RAISE EXCEPTION 'RLS verification FAILED (rolling back): % forced table(s) have NO policy (dangerous deny-all half-state)', n_unpol;
  END IF;

  RAISE NOTICE 'RLS verification PASSED: 42 tables ENABLE+FORCE+policied, app_tenant_in_scope() present. Committing.';
END
$verify$;

COMMIT;

-- =====================================================================
-- POST-COMMIT READINESS PROOF (read-only; prints the committed state)
-- =====================================================================
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE c.relkind='r' AND ns.nspname='public' AND c.relrowsecurity)                          AS tables_rls_enabled,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE c.relkind='r' AND ns.nspname='public' AND c.relforcerowsecurity)                      AS tables_rls_forced,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE c.relkind='r' AND ns.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables_enable_and_force,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public')                                    AS total_policies,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
     WHERE p.proname='app_tenant_in_scope' AND ns.nspname='public')                              AS app_tenant_in_scope_present;

-- Per-table proof: every forced table with its policy count (should be >= 1 each).
SELECT c.relname AS table_name,
       c.relrowsecurity      AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policies p
          WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
 WHERE c.relkind='r' AND ns.nspname='public'
   AND (c.relrowsecurity OR c.relforcerowsecurity)
 ORDER BY c.relname;
