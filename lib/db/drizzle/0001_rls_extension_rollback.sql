-- ============================================================================
-- Rollback for 0001_rls_extension.sql
-- ============================================================================
-- Removes the tenant_isolation policy and disables RLS on the Phase A
-- tables. Leaves the pilot 3 tables (candidates, applications,
-- interview_sessions) untouched — to roll those back, see
-- 0000_rls_pilot_rollback.sql.
-- ============================================================================
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'jobs', 'ideal_candidate_profiles',
    'outreach_campaigns', 'recruiter_inbox_items',
    'outreach_enrollments', 'outreach_messages',
    'talent_matches', 'resume_screens',
    'talent_pool_submissions', 'sourced_candidates',
    'candidate_notifications', 'user_notifications',
    'communication_events', 'ghosting_risk_flags',
    'ghosting_alerts', 'nurture_pool',
    'interview_plans', 'interview_schedules', 'trust_events',
    'candidate_rejections',
    'pipeline_runs', 'job_pipelines',
    'prep_plans', 'prep_sessions',
    'candidate_action_events',
    'tenant_decision_policies',
    'credit_usage_events',
    'candidate_import_batches', 'candidate_import_records',
    'verification_records',
    'billing_invoices', 'billing_subscriptions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END$$;
