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
