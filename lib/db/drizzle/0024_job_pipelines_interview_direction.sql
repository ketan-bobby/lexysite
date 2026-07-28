-- Per-type + _default recruiter interview direction (focus / theme + custom
-- questions), surfaced in the Workflow configurator and the pipeline
-- "Interview Setup" control. Shape:
--   { [type]: { focusDirective?: text, customQuestions?: text[] }, _default?: {...} }
ALTER TABLE "job_pipelines" ADD COLUMN IF NOT EXISTS "interview_direction" jsonb NOT NULL DEFAULT '{}'::jsonb;
