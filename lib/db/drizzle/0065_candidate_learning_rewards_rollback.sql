BEGIN;
DROP TABLE IF EXISTS candidate_learning_reward_ledger;
DROP TABLE IF EXISTS candidate_learning_course_review_lessons;
DROP TABLE IF EXISTS candidate_learning_course_review_attempts;
DROP FUNCTION IF EXISTS candidate_learning_owner_scope(text, text);
ALTER TABLE candidate_learning_voice_cycles DROP CONSTRAINT IF EXISTS candidate_learning_voice_cycles_training_evidence_chk;
ALTER TABLE candidate_learning_voice_cycles ADD CONSTRAINT candidate_learning_voice_cycles_training_evidence_chk CHECK (
  (training_completed_at IS NULL AND training_evidence IS NULL)
  OR (state IN ('training', 'progress_draft', 'completed') AND training_completed_at IS NOT NULL
    AND training_evidence IN ('enrollment_completion', 'candidate_confirmed_review'))
);
COMMIT;