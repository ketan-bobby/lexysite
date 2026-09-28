BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_assessments_id_candidate_tenant_uidx
  ON candidate_learning_assessments (id, candidate_id, tenant_id);

ALTER TABLE candidate_learning_assessment_tasks
  DROP CONSTRAINT IF EXISTS candidate_learning_assessment_tasks_parent_owner_fk;
ALTER TABLE candidate_learning_assessment_tasks
  ADD CONSTRAINT candidate_learning_assessment_tasks_parent_owner_fk
  FOREIGN KEY (assessment_id, candidate_id, tenant_id)
  REFERENCES candidate_learning_assessments (id, candidate_id, tenant_id)
  ON DELETE CASCADE;

COMMIT;