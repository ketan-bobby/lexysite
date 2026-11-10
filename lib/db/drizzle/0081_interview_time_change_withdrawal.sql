-- Additive rollout: preserve requests and their original proposal history.
ALTER TABLE interview_time_change_requests
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'interview_time_change_requests'::regclass
      AND conname = 'interview_time_change_review_or_withdrawal'
  ) THEN
    ALTER TABLE interview_time_change_requests
      ADD CONSTRAINT interview_time_change_review_or_withdrawal
      CHECK (reviewed_at IS NULL OR withdrawn_at IS NULL);
  END IF;
END $$;
