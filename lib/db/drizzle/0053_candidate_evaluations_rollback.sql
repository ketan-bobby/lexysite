-- 0053_candidate_evaluations_rollback.sql
DROP POLICY IF EXISTS candidate_evaluations_select ON candidate_evaluations;
DROP POLICY IF EXISTS candidate_evaluations_insert ON candidate_evaluations;
DROP POLICY IF EXISTS candidate_evaluations_update ON candidate_evaluations;
DROP POLICY IF EXISTS candidate_evaluations_delete ON candidate_evaluations;
DROP TABLE IF EXISTS candidate_evaluations;
