-- Rollback for 0005: restore 0004's permissive cae_select & drop the index.

DROP INDEX IF EXISTS users_tenant_id_idx;

DROP POLICY IF EXISTS cae_select ON candidate_action_events;

CREATE POLICY cae_select ON candidate_action_events
  FOR SELECT TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR viewer_tenant_id IS NULL
    OR viewer_tenant_id = current_setting('app.current_tenant_id', true)
  );
