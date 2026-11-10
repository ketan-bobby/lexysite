// Canonical PostgreSQL expression from reviewed migration 0076.
// Shared by release audits so the older catalog check cannot reject the
// activity labels required by the newer meeting/usage check. Keep exact
// comparison: accepting a label subset would also accept permissive OR true.
export const expectedUsageArea =
  "CHECK (((area = ANY (ARRAY['unattributed'::text, 'interview_unclassified'::text])) OR (area ~ '^workflow:[A-Za-z0-9_-]{1,128}:(screening|verification|engagement|ai_interview|human_interview|discovery|enrichment)$'::text) OR (area = ANY (ARRAY['activity:screening'::text, 'activity:matching'::text, 'activity:intelligence'::text, 'activity:assessment'::text, 'activity:interview'::text, 'activity:development_private'::text, 'activity:recruiter'::text, 'activity:other'::text]))))";
