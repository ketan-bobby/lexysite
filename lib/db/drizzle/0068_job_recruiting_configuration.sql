-- Development schema addition. Verify the target separately before production rollout.
-- Defaults preserve legacy rows; these values never enable autonomous execution.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  CREATE TYPE recruiting_mode AS ENUM ('human_assisted', 'lexy_autonomous');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE interview_path AS ENUM ('ai', 'human', 'ai_then_human', 'human_then_ai', 'recruiter_choice');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS recruiting_mode recruiting_mode NOT NULL DEFAULT 'human_assisted',
  ADD COLUMN IF NOT EXISTS interview_path interview_path NOT NULL DEFAULT 'recruiter_choice';

COMMIT;
