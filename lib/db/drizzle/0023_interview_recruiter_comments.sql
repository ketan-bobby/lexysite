-- Recruiter free-text comments on a completed interview's AI assessment.
-- Surfaced in the client-shareable interview performance PDF. Nullable.
ALTER TABLE "interview_summaries" ADD COLUMN IF NOT EXISTS "recruiter_comments" text;
