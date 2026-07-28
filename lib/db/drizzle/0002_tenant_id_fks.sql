-- ============================================================================
-- Tenant-ID Foreign Keys
-- ============================================================================
--
-- Adds tenant_id → tenants(id) FK constraints to every RLS-protected
-- tenant-scoped table. Before this migration, the only table in the entire
-- schema with any FK constraint was `messages`; everything else stored
-- tenant ids as bare text. That meant the database could not, on its own,
-- prevent orphaned rows after a tenant was deleted, nor catch a typo'd
-- tenant id at write time.
--
-- ─── Pre-flight verification (done before applying) ─────────────────────────
-- For every column listed below we ran:
--   SELECT count(*) FROM <table> x WHERE x.<col> IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM tenants WHERE tenants.id = x.<col>)
-- and confirmed zero orphans across all 35 tables. If a future deploy
-- re-runs this migration on a database that does have orphans, the
-- ADD CONSTRAINT statement will fail loudly — that's the intended
-- behaviour. Clean up the orphans first, then re-run.
--
-- ─── ON DELETE choice ───────────────────────────────────────────────────────
-- We use ON DELETE CASCADE. Deleting a tenant is an unusual, intentional
-- operation (account closure, GDPR erasure, test cleanup), and when it
-- happens we want every dependent row to go with it — leaving orphans
-- around would just recreate today's problem under a slightly different
-- name. The Phase B tables (users, invite_tokens, etc.) get their own
-- treatment when they're brought under RLS.
--
-- ─── Why this is in a separate migration from RLS ───────────────────────────
-- RLS is a runtime check on every query; FKs are a write-time check at
-- the storage layer. They are independent defenses and worth landing
-- separately so a rollback of one doesn't drag the other with it.
--
-- ─── Schema-file note ───────────────────────────────────────────────────────
-- This project's migrations are hand-written rather than drizzle-kit
-- generated, so the `text("tenant_id")` declarations in lib/db/src/schema/
-- intentionally do NOT carry .references() — keeping the schema file
-- minimal avoids cross-file import cycles (tenants.ts is imported
-- everywhere). The constraint lives in the database where it is enforced.
--
-- ─── Rollback ───────────────────────────────────────────────────────────────
-- See 0002_tenant_id_fks_rollback.sql.
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
  cname text;
BEGIN
  FOR i IN 1 .. array_length(tables, 1) LOOP
    tbl := tables[i][1];
    col := tables[i][2];
    cname := format('%s_%s_tenants_fk', tbl, col);

    /* Idempotent: drop existing constraint with this name first.
     * pg_constraint has no IF NOT EXISTS for ADD CONSTRAINT, so we
     * achieve idempotency by always dropping then re-adding. */
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      tbl, cname
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES tenants(id) ON DELETE CASCADE',
      tbl, cname, col
    );
  END LOOP;
END$$;
