-- Operations-only measurement. No app-role policies, prices or dispatch changes.
BEGIN;
ALTER TABLE vendor_usage_attempts DROP CONSTRAINT vendor_usage_attempts_area_check;
ALTER TABLE vendor_usage_attempts ADD CONSTRAINT vendor_usage_attempts_area_check CHECK (
  area IN ('unattributed', 'interview_unclassified')
  OR area ~ '^workflow:[A-Za-z0-9_-]{1,128}:(screening|verification|engagement|ai_interview|human_interview|discovery|enrichment)$'
  OR area IN ('activity:screening', 'activity:matching', 'activity:intelligence',
    'activity:assessment', 'activity:interview', 'activity:development_private',
    'activity:recruiter', 'activity:other')
);
COMMIT;
