-- Keep existing telemetry labels and permit only bound workflow/step labels.
-- This is observation, not spending authority. RLS and cost constraints stay intact.
BEGIN;
ALTER TABLE vendor_usage_attempts
  DROP CONSTRAINT vendor_usage_attempts_area_check;
ALTER TABLE vendor_usage_attempts
  ADD CONSTRAINT vendor_usage_attempts_area_check CHECK (
    area IN ('unattributed', 'interview_unclassified')
    OR area ~ '^workflow:[A-Za-z0-9_-]{1,128}:(screening|verification|engagement|ai_interview|human_interview)$'
  );
COMMIT;
