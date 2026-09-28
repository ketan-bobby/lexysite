BEGIN;

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
    policy_prefix := table_name || '_owner_';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'select', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'insert', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'update', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_prefix || 'delete', table_name);

    policy_prefix := table_name || '_tenant_';
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO lexy_app USING (app_tenant_in_scope(tenant_id))',
      policy_prefix || 'select',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO lexy_app WITH CHECK (app_tenant_in_scope(tenant_id))',
      policy_prefix || 'insert',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO lexy_app USING (app_tenant_in_scope(tenant_id)) WITH CHECK (app_tenant_in_scope(tenant_id))',
      policy_prefix || 'update',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO lexy_app USING (app_tenant_in_scope(tenant_id))',
      policy_prefix || 'delete',
      table_name
    );
  END LOOP;
END $$;

COMMIT;