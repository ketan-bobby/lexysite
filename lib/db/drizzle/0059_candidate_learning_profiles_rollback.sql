BEGIN;

DROP TABLE IF EXISTS candidate_learning_profiles;
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_id_tenant_unique;

COMMIT;