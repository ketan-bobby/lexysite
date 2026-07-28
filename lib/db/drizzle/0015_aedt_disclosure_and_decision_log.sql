-- 0015_aedt_disclosure_and_decision_log.sql
--
-- NYC Local Law 144 readiness.
--
-- jobs.aedt_enabled              — tenant flags this job as using an AEDT.
--                                  Triggers the candidate-facing notice
--                                  page and starts the 10-business-day
--                                  notice clock.
-- jobs.aedt_notice_published_at  — first timestamp the public notice
--                                  was rendered; auditor uses this to
--                                  verify the 10-day notice requirement.
--
-- ai_decision_log                — append-only auditor-facing record of
--                                  every AI-driven recommendation.
--                                  Joined to candidate_demographics in
--                                  the /analytics/aedt-export endpoint
--                                  with k-anonymity ≥ 5.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS aedt_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS aedt_notice_published_at timestamptz;

CREATE TABLE IF NOT EXISTS ai_decision_log (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  job_id text,
  candidate_id text,
  decision_type text NOT NULL,
  score integer,
  decision_bool boolean,
  label text,
  input_hash text,
  model_id text,
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_decision_log_tenant_job_idx
  ON ai_decision_log (tenant_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS ai_decision_log_candidate_idx
  ON ai_decision_log (candidate_id);
CREATE INDEX IF NOT EXISTS ai_decision_log_type_idx
  ON ai_decision_log (decision_type, created_at);
