/* Rollback for migration 0016. Drops governance objects in reverse dependency order. */
DROP TRIGGER IF EXISTS decision_events_block_update_trg ON decision_events;
DROP TRIGGER IF EXISTS decision_events_block_delete_trg ON decision_events;
DROP FUNCTION IF EXISTS decision_events_block_mutation();

DROP TABLE IF EXISTS decision_events;
DROP TABLE IF EXISTS appeals_requests;

DROP TRIGGER IF EXISTS jurisdiction_policy_block_mutation_trg ON jurisdiction_ai_policy_rules;
DROP TRIGGER IF EXISTS jurisdiction_policy_block_delete_trg ON jurisdiction_ai_policy_rules;
DROP FUNCTION IF EXISTS jurisdiction_policy_block_mutation();
DROP FUNCTION IF EXISTS jurisdiction_policy_block_delete();

DROP TABLE IF EXISTS jurisdiction_disclosure_templates;
DROP TABLE IF EXISTS jurisdiction_ai_policy_rules;

DROP INDEX IF EXISTS applications_pending_human_review_idx;
DROP INDEX IF EXISTS applications_gated_jurisdiction_idx;

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_final_decision_requires_human;
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_final_decision_requires_attestation;

ALTER TABLE applications
  DROP COLUMN IF EXISTS ai_recommendation,
  DROP COLUMN IF EXISTS ai_recommendation_at,
  DROP COLUMN IF EXISTS ai_recommendation_model,
  DROP COLUMN IF EXISTS ai_recommendation_score,
  DROP COLUMN IF EXISTS final_decision,
  DROP COLUMN IF EXISTS final_decision_by,
  DROP COLUMN IF EXISTS final_decision_at,
  DROP COLUMN IF EXISTS final_decision_attestation,
  DROP COLUMN IF EXISTS final_decision_reason,
  DROP COLUMN IF EXISTS gated_by_jurisdiction,
  DROP COLUMN IF EXISTS policy_version_id;

DROP TYPE IF EXISTS final_decision_enum;
DROP TYPE IF EXISTS ai_recommendation_enum;
