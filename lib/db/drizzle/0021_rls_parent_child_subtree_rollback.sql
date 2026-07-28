-- ============================================================================
-- ROLLBACK for 0021_rls_parent_child_subtree.sql
-- ============================================================================
--
-- Restores the pre-0021 policy shape: every policy keys row visibility on the
-- caller's OWN tenant via app.current_tenant_id (the 0000/0001 standard shape,
-- and the 0004/0005 bespoke cae_/tps_ shape). Drops the app_tenant_in_scope
-- helper.
--
-- NOTE: after running this, the withTenantContext middleware still sets the
-- now-unused app.allowed_tenant_ids GUC. That is harmless (no policy reads it).
-- ============================================================================

-- 1. Restore standard tenant_isolation policies (own-tenant only).
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'candidates',
    'applications',
    'interview_sessions',
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
        USING (
          current_setting('app.is_platform_admin', true) = 'true'
          OR tenant_id = current_setting('app.current_tenant_id', true)
        )
        WITH CHECK (
          current_setting('app.is_platform_admin', true) = 'true'
          OR tenant_id = current_setting('app.current_tenant_id', true)
        )
    $f$, tbl);
  END LOOP;
END$$;

-- 2. Restore cae_select to the 0005 (own-tenant) shape.
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

-- 3. Restore tps_select / tps_update / tps_delete to the 0004 (own-tenant) shape.
DROP POLICY IF EXISTS tps_select ON talent_pool_submissions;
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

DROP POLICY IF EXISTS tps_update ON talent_pool_submissions;
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

DROP POLICY IF EXISTS tps_delete ON talent_pool_submissions;
CREATE POLICY tps_delete ON talent_pool_submissions
  FOR DELETE TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
  );

-- 4. Drop the helper function.
DROP FUNCTION IF EXISTS app_tenant_in_scope(text);
