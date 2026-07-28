-- Rollback for 0057_rls_classb_pii_tables.sql
-- Removes the tenant_isolation policies and disables RLS on the 8 tables.

\set ON_ERROR_STOP on

BEGIN;

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
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END$$;

COMMIT;
