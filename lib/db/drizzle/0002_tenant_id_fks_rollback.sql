-- ============================================================================
-- Rollback for 0002_tenant_id_fks.sql
-- ============================================================================
-- Drops the tenant_id FK constraints added by the companion migration.
-- Note: this does NOT touch the pre-existing FK constraints on `messages`
-- (which were added independently when that table was introduced) or any
-- non-tenant FKs that may have been added separately.
-- ============================================================================
DO $$
DECLARE
  tables text[][] := ARRAY[
    ['candidates',                 'tenant_id'],
    ['applications',               'tenant_id'],
    ['interview_sessions',         'tenant_id'],
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
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      tbl, format('%s_%s_tenants_fk', tbl, col)
    );
  END LOOP;
END$$;
