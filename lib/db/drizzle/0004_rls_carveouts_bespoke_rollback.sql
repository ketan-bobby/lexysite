-- Rollback for 0004_rls_carveouts_bespoke.sql
-- Restores the post-0003 state: RLS DISABLED on both tables.

DROP POLICY IF EXISTS cae_insert ON candidate_action_events;
DROP POLICY IF EXISTS cae_select ON candidate_action_events;
DROP POLICY IF EXISTS cae_update ON candidate_action_events;
DROP POLICY IF EXISTS cae_delete ON candidate_action_events;
ALTER TABLE candidate_action_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_action_events DISABLE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tps_insert ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_select ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_update ON talent_pool_submissions;
DROP POLICY IF EXISTS tps_delete ON talent_pool_submissions;
ALTER TABLE talent_pool_submissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE talent_pool_submissions DISABLE   ROW LEVEL SECURITY;
