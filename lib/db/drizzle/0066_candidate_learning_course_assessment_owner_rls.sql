BEGIN;

CREATE OR REPLACE FUNCTION candidate_learning_owner_scope(row_tenant text, row_candidate text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app_tenant_in_scope(row_tenant)
    AND row_candidate = nullif(current_setting('app.current_candidate_id', true), '')
$$;

DO $$
DECLARE
  table_name text;
  policy_prefix text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'candidate_learning_enrollments',
    'candidate_learning_lesson_progress',
    'candidate_learning_assessments',
    'candidate_learning_assessment_tasks'
  ] LOOP
    policy_prefix := table_name || '_tenant_';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'select', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'insert', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'update', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'delete', table_name);

    policy_prefix := table_name || '_owner_';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'select', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id))',
      policy_prefix || 'select',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'insert', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO lexy_app WITH CHECK (candidate_learning_owner_scope(tenant_id, candidate_id))',
      policy_prefix || 'insert',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'update', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id)) WITH CHECK (candidate_learning_owner_scope(tenant_id, candidate_id))',
      policy_prefix || 'update',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'delete', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id))',
      policy_prefix || 'delete',
      table_name
    );
  END LOOP;
END $$;

COMMIT;