-- ============================================================================
-- Follow-up to 0004 — index + cae_select tightening
-- ============================================================================
--
-- Two corrections after the second architect review of the carve-out
-- policies:
--
-- 1) The `users(tenant_id)` index that 0004's tps_select policy relies on
--    via `pushed_by_user_id IN (SELECT id FROM users WHERE tenant_id = …)`
--    did NOT actually exist (despite what 0004's comment claimed). At any
--    non-trivial users row count that subquery would degrade to a seq
--    scan on every SELECT against talent_pool_submissions. Add the index.
--
-- 2) `cae_select` previously allowed `viewer_tenant_id IS NULL` for ANY
--    authenticated caller. The architect flagged this as a cross-tenant
--    read of candidate-side event rows (mock_interview_completed,
--    log-action, role_open_at_target). Tighten so NULL-viewer rows are
--    only visible to a caller whose tenant owns the referenced candidate.
--
--    The candidates table is RLS-protected (0001), and the subquery
--    inherits that — so the EXISTS only returns true when the caller's
--    standard candidates policy would have let them SELECT the candidate
--    row. This is the same access surface a recruiter already has when
--    viewing the candidate's profile elsewhere; it just stops a random
--    other tenant from enumerating candidate activity by candidate_id.
--
--    Candidate-portal flows still work: the candidate-user's `tenant_id`
--    column points at the candidate's owning tenant, so their session
--    sets the matching GUC and the EXISTS succeeds.
-- ============================================================================

CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users (tenant_id);

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
