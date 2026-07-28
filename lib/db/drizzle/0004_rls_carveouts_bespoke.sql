-- ============================================================================
-- RLS Carve-outs — bespoke policies for candidate_action_events &
-- talent_pool_submissions
-- ============================================================================
--
-- Migration 0003_rls_extension_fix.sql disabled RLS on these two tables
-- because the standard "tenant_id = current_setting('app.current_tenant_id')"
-- policy emitted by 0001 didn't fit their access patterns. This migration
-- brings them back under RLS with table-specific policies grounded in the
-- actual queries issued by the app (audit performed 2026-05-16).
--
-- ────────────────────────────────────────────────────────────────────────────
-- 1) candidate_action_events
-- ────────────────────────────────────────────────────────────────────────────
-- Schema:
--   candidate_id    text NOT NULL  -- the candidate this event is about
--   event_type      text NOT NULL  -- 'recruiter_view' | 'mock_interview_completed'
--                                  -- | 'role_open_at_target' | 'log-action' | ...
--   viewer_tenant_id text NULL    -- populated ONLY for recruiter_view events
--   payload         jsonb
--
-- Query patterns (from career-profile.ts):
--   • INSERT from 4+ event emitters; viewer_tenant_id is NULL for the
--     candidate-side event types (mock interview completed, log-action,
--     role-open-at-target). The 0001 policy rejected those INSERTs.
--   • SELECT by candidate_id filtered on event_type='recruiter_view' to
--     answer "did your tenant view this candidate" — recruiter-side reads
--     where the row's viewer_tenant_id matches the caller's tenant.
--   • SELECT by candidate_id with no viewer_tenant_id predicate — the
--     candidate's own activity feed (candidate-portal session).
--
-- Bespoke policy:
--   INSERT — allow always. This is an append-only audit log; the route-
--     level auth already authenticated the caller, and we deliberately do
--     not gate INSERTs by current_tenant_id because the legitimate
--     candidate-side emitters intentionally write viewer_tenant_id=NULL.
--   SELECT — allow when (a) platform_admin, OR (b) viewer_tenant_id IS NULL
--     (candidate-side rows: the candidate-portal handler filters by
--     candidate_id which is the real access gate), OR (c) the row's
--     viewer_tenant_id matches the caller (a recruiter looking at their
--     own viewing history). This still prevents recruiter tenant A from
--     reading recruiter tenant B's view-attribution rows, which was the
--     original cross-tenant leak.
--   UPDATE / DELETE — platform_admin only. The table is meant to be
--     immutable; mutations only happen from migration/cleanup tooling.
--
-- Known residual: NULL viewer_tenant_id rows are visible to anyone with a
--   valid tenant context. Routes that surface them MUST keep filtering by
--   candidate_id and enforcing candidate-portal authz at the app layer.
--   Tightening to "viewer_tenant_id IS NULL AND caller owns candidate_id"
--   requires a subquery into candidates and is deferred — tracked as a
--   follow-up. See RLS_PILOT.md.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE candidate_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_action_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cae_insert ON candidate_action_events;
DROP POLICY IF EXISTS cae_select ON candidate_action_events;
DROP POLICY IF EXISTS cae_update ON candidate_action_events;
DROP POLICY IF EXISTS cae_delete ON candidate_action_events;

CREATE POLICY cae_insert ON candidate_action_events
  FOR INSERT TO lexy_app
  WITH CHECK (true);

CREATE POLICY cae_select ON candidate_action_events
  FOR SELECT TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR viewer_tenant_id IS NULL
    OR viewer_tenant_id = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY cae_update ON candidate_action_events
  FOR UPDATE TO lexy_app
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY cae_delete ON candidate_action_events
  FOR DELETE TO lexy_app
  USING (current_setting('app.is_platform_admin', true) = 'true');

-- ────────────────────────────────────────────────────────────────────────────
-- 2) talent_pool_submissions
-- ────────────────────────────────────────────────────────────────────────────
-- Schema (relevant cols):
--   candidate_id        text NULL  -- populated for recruiter-pushed rows
--   client_tenant_id    text NULL  -- the tenant the candidate is pushed TO
--   pushed_by_user_id   text NULL  -- the user (in the RECRUITER tenant)
--                                     who created the push
--   <other intake fields>
--
-- Query patterns:
--   • INSERT from /public/talent-pool (intake form, dbAdmin, no auth) —
--     leaves candidate_id / client_tenant_id NULL.
--   • INSERT from candidates.ts push-to-client (recruiter tenant) — sets
--     candidate_id, client_tenant_id (DIFFERENT tenant), pushed_by_user_id.
--   • SELECT by candidate_id (candidates.ts) — recruiter answering
--     "how many clients has this candidate been pushed to". The recruiter
--     who originated the push lives in tenant X; the row's client_tenant_id
--     is tenant Y. Scoping by client_tenant_id alone would HIDE the row
--     from its own author.
--   • SELECT by client_tenant_id (candidates.ts inbox view) — the
--     receiving client tenant browses incoming submissions.
--   • SELECT by job_posting_id (jobs.ts + candidates.ts) — recruiter
--     view, same problem as candidate_id SELECT.
--
-- Bespoke policy:
--   INSERT — allow always (recruiter-side pushes legitimately write rows
--     whose client_tenant_id ≠ current_tenant_id; the public-intake path
--     uses dbAdmin and bypasses RLS entirely).
--   SELECT — allow when (a) platform_admin, OR (b) client_tenant_id IS
--     NULL (intake rows are public-by-design until processed), OR (c) the
--     row's client_tenant_id matches the caller (client-side inbox), OR
--     (d) the row's pushed_by_user_id belongs to a user in the caller's
--     tenant (recruiter-side own-push history — subquery into users,
--     which is BYPASSRLS so the lookup returns the right set).
--   UPDATE / DELETE — client_tenant_id = caller (client manages their
--     own pipeline) OR platform_admin. The recruiter who pushed cannot
--     retract the row from the client side; that intentionally matches
--     the product design ("a push is a record, not a draft").
--
-- Performance note: the pushed_by_user_id subquery hits users by
-- tenant_id. users(tenant_id) is indexed (FK + b-tree from 0001), so the
-- planner can fold this into a hashed semi-join — measured cost is
-- negligible at current row counts.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE talent_pool_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_pool_submissions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tps_insert ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_select ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_update ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_delete ON talent_pool_submissions;

CREATE POLICY tps_insert ON talent_pool_submissions
  FOR INSERT TO lexy_app
  WITH CHECK (true);

CREATE POLICY tps_select ON talent_pool_submissions
  FOR SELECT TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id IS NULL
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
    OR pushed_by_user_id IN (
      SELECT id FROM users
      WHERE tenant_id = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tps_update ON talent_pool_submissions
  FOR UPDATE TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tps_delete ON talent_pool_submissions
  FOR DELETE TO lexy_app
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR client_tenant_id = current_setting('app.current_tenant_id', true)
  );
