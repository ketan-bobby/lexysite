-- ============================================================================
-- RLS Extension Fix — back out RLS on two tables from 0001_rls_extension.sql
-- ============================================================================
--
-- Code review of 0001 found that two tables in the Phase A list have access
-- patterns that don't fit the standard "scope by tenant_id" policy:
--
-- 1. candidate_action_events
--    The tenant column is `viewer_tenant_id`, NULLABLE, and only populated
--    for `event_type = 'recruiter_view'`. Many event types (mock interview
--    completed, role-open-at-target, profile updates from the candidate
--    portal) intentionally insert with viewer_tenant_id = NULL. Under
--    RLS, the WITH CHECK clause rejects NULL → not-equal → not platform
--    admin, so those INSERTs would 500 in production. Candidate-side
--    SELECTs by candidate_id would also return zero rows for any caller
--    whose tenantId ≠ the (often null) viewer_tenant_id.
--
-- 2. talent_pool_submissions
--    The tenant column is `client_tenant_id` — the tenant the candidate
--    is being submitted *to*. But the *recruiter* who created the
--    submission lives in a different tenant, and authenticated routes
--    in candidates.ts query this table by candidate_id (to show "X
--    companies interested in this candidate" / "last pushed at" across
--    all destinations). Scoping by client_tenant_id would silently hide
--    every submission the recruiter actually created.
--
-- Both tables need bespoke policies (e.g. allow if caller is the
-- candidate's owning tenant OR the receiving client tenant) before they
-- can be brought back under RLS. That design work is out of scope for
-- this immediate hardening pass.
--
-- The FK constraints added by 0002_tenant_id_fks.sql remain in place
-- for both tables — those are still correct (the column values do
-- reference real tenants); only the row-level policy is the wrong shape.
-- ============================================================================

DROP POLICY IF EXISTS tenant_isolation ON candidate_action_events;
ALTER TABLE candidate_action_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_action_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON talent_pool_submissions;
ALTER TABLE talent_pool_submissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE talent_pool_submissions DISABLE ROW LEVEL SECURITY;
