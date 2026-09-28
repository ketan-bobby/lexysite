BEGIN;

ALTER TABLE candidate_learning_voice_cycles
  ADD COLUMN IF NOT EXISTS training_completed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS training_evidence text;
ALTER TABLE candidate_learning_voice_cycles
  DROP CONSTRAINT IF EXISTS candidate_learning_voice_cycles_training_evidence_chk;
ALTER TABLE candidate_learning_voice_cycles
  ADD CONSTRAINT candidate_learning_voice_cycles_training_evidence_chk CHECK (
    (training_completed_at IS NULL AND training_evidence IS NULL)
    OR (state IN ('training', 'progress_draft', 'completed')
      AND training_completed_at IS NOT NULL
      AND training_evidence IN ('enrollment_completion', 'candidate_confirmed_review'))
  );

DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_select ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_select ON candidate_learning_voice_cycles
  FOR SELECT TO lexy_app
  USING (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));
DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_insert ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_insert ON candidate_learning_voice_cycles
  FOR INSERT TO lexy_app
  WITH CHECK (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));
DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_update ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_update ON candidate_learning_voice_cycles
  FOR UPDATE TO lexy_app
  USING (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''))
  WITH CHECK (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));
DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_delete ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_delete ON candidate_learning_voice_cycles
  FOR DELETE TO lexy_app
  USING (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));

DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_select ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_select ON candidate_learning_voice_turns
  FOR SELECT TO lexy_app
  USING (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));
DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_insert ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_insert ON candidate_learning_voice_turns
  FOR INSERT TO lexy_app
  WITH CHECK (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));
DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_update ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_update ON candidate_learning_voice_turns
  FOR UPDATE TO lexy_app
  USING (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''))
  WITH CHECK (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));
DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_delete ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_delete ON candidate_learning_voice_turns
  FOR DELETE TO lexy_app
  USING (app_tenant_in_scope(tenant_id) AND candidate_id = nullif(current_setting('app.current_candidate_id', true), ''));

COMMIT;