-- Observation labels only: retain forced RLS, policies and unknown-cost semantics.
-- Native requests must not disappear simply because their phase is not an
-- assessment step. This does not grant execution authority.
BEGIN;
ALTER TABLE vendor_usage_attempts
  DROP CONSTRAINT vendor_usage_attempts_area_check;
ALTER TABLE vendor_usage_attempts
  ADD CONSTRAINT vendor_usage_attempts_area_check CHECK (
    area IN ('unattributed', 'interview_unclassified')
    OR area ~ '^workflow:[A-Za-z0-9_-]{1,128}:(screening|verification|engagement|ai_interview|human_interview|discovery|enrichment)$'
  );
COMMIT;
