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
