-- Additive migration only. Apply to the configured API database before rollout.
-- No broad schema push: preserve existing grants, RLS and immutable triggers.
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS storage_cleanup jsonb;
CREATE INDEX IF NOT EXISTS deletion_cleanup_pending_idx
  ON deletion_requests ((storage_cleanup->>'nextAttemptAt'))
  WHERE storage_cleanup IS NOT NULL AND status = 'in_progress';
