/* Rollback for migration 0017. Drops the four new tables and the
 * extra columns on appeals_requests. Pairs 1:1 with the forward file
 * so a dev DB can be reset cleanly. */
DROP TRIGGER IF EXISTS admin_impersonation_immutable           ON admin_impersonation_sessions;
DROP TRIGGER IF EXISTS candidate_disclosure_acks_no_update     ON candidate_disclosure_acks;
DROP TRIGGER IF EXISTS candidate_disclosure_acks_no_delete     ON candidate_disclosure_acks;

DROP FUNCTION IF EXISTS admin_impersonation_block_mutation();
DROP FUNCTION IF EXISTS candidate_disclosure_acks_block_mutation();

DROP TABLE IF EXISTS admin_impersonation_sessions;
DROP TABLE IF EXISTS stripe_processed_events;
DROP TABLE IF EXISTS candidate_disclosure_acks;

ALTER TABLE appeals_requests
  DROP CONSTRAINT IF EXISTS appeals_resolved_requires_attestation_chk,
  DROP CONSTRAINT IF EXISTS appeals_outcome_values_chk,
  DROP COLUMN IF EXISTS candidate_notified_at,
  DROP COLUMN IF EXISTS reviewer_attestation,
  DROP COLUMN IF EXISTS outcome_notes,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS sla_due_at;
