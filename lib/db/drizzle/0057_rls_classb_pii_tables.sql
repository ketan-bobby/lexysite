-- ============================================================================
-- 0057 — RLS extension to Class B PII tables (batch 1: strictly tenant-scoped)
-- ============================================================================
--
-- Extends the tenant_isolation RLS pattern (see 0021_rls_parent_child_subtree)
-- to eight tables that hold PII / sensitive scoring data but never had
-- policies ("Class B" — app-code was the sole tenant seal).
--
-- Selection criteria (verified 2026-07-23 against code + dev data):
--   - has a NOT NULL tenant_id column with zero NULL rows
--   - every request-scoped read/write (via the RLS-constrained `db` proxy)
--     stays inside the caller's allowed tenant subtree
--   - background/scheduler access uses dbAdmin (BYPASSRLS) and is unaffected
--
-- DELIBERATELY EXCLUDED from this batch (documented known gaps):
--   - candidate_job_intelligence — legit cross-tenant read in the candidate
--     GDPR self-export path (career-profile.ts) via the request-scoped proxy
--   - decision_events, ai_decision_log — cross-tenant analytics/governance
--     reads need review of caller roles before a policy can be added
--   - hiring_manager_shares, stt_transcribe_events — dbAdmin-only by design
--   - tables WITHOUT a tenant_id column (candidate_ai_consent,
--     candidate_career_profiles, candidate_demographics, candidate_skill_scores,
--     interview_summaries, outreach_replies/sequence_steps/step_messages/
--     autopilot_runs) — need a join-based policy or a tenant column first
--
-- APPLY with psql, never drizzle-kit push (push strips policies):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/drizzle/0057_rls_classb_pii_tables.sql
-- Rollback: 0057_rls_classb_pii_tables_rollback.sql
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Grants are normally covered by ALTER DEFAULT PRIVILEGES from 0000, but be
-- explicit for tables that may predate it.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  candidate_outcomes,
  candidate_events,
  candidate_embeddings,
  outreach_conversation_drafts,
  workorder_ai_contexts,
  workorder_ai_documents,
  tenant_ai_brand_profiles,
  tenant_ai_documents
TO lexy_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'candidate_outcomes',
    'candidate_events',
    'candidate_embeddings',
    'outreach_conversation_drafts',
    'workorder_ai_contexts',
    'workorder_ai_documents',
    'tenant_ai_brand_profiles',
    'tenant_ai_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lexy_app
         USING (app_tenant_in_scope(tenant_id))
         WITH CHECK (app_tenant_in_scope(tenant_id))', t);
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- In-transaction verification: all 8 tables ENABLE+FORCE with a policy, and
-- no forced table anywhere is left unpolicied (deny-all half-state).
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  n_ok int; n_unpol int;
BEGIN
  SELECT count(*) INTO n_ok
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname='public' AND c.relkind='r'
     AND c.relname IN ('candidate_outcomes','candidate_events','candidate_embeddings',
                       'outreach_conversation_drafts','workorder_ai_contexts',
                       'workorder_ai_documents','tenant_ai_brand_profiles','tenant_ai_documents')
     AND c.relrowsecurity AND c.relforcerowsecurity
     AND EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname='public' AND p.tablename=c.relname
                    AND p.policyname='tenant_isolation');

  SELECT count(*) INTO n_unpol
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname='public' AND c.relkind='r'
     AND c.relrowsecurity AND c.relforcerowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname='public' AND p.tablename=c.relname);

  IF n_ok <> 8 THEN
    RAISE EXCEPTION '0057 verification FAILED (rolling back): expected 8 policied tables, found %', n_ok;
  END IF;
  IF n_unpol <> 0 THEN
    RAISE EXCEPTION '0057 verification FAILED (rolling back): % forced table(s) without a policy', n_unpol;
  END IF;
  RAISE NOTICE '0057 verification PASSED: 8 Class-B PII tables now ENABLE+FORCE+policied.';
END
$verify$;

COMMIT;
