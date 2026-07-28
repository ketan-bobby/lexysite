-- 0053_candidate_evaluations.sql
--
-- Client-facing candidate evaluation reports. One rich, versioned evaluation per
-- candidate×job: a single structured object (ai_content) + a sparse recruiter
-- overlay (human_edits) that together drive BOTH the in-app report view and the
-- client-ready PDF. Human-driven: the AI drafts, the recruiter overrides which
-- competencies appear and edits every section, and nothing reaches a client until
-- approval_state flips to 'approved'.
--
-- tenant_id is the JOB's tenant. FORCE RLS (Class-A pattern, mirrors 0050) — app
-- routes ALSO apply the same tenant predicate explicitly (dev strips RLS on most
-- tables; the policy is the prod backstop, not the only seal).

CREATE TABLE IF NOT EXISTS candidate_evaluations (
  id                    text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id             text NOT NULL,
  job_id                text NOT NULL,
  candidate_id          text NOT NULL,
  ai_content            jsonb NOT NULL,
  human_edits           jsonb,
  competency_keys       text[] NOT NULL DEFAULT '{}',
  recommendation_band   text NOT NULL DEFAULT 'further_assessment',
  confidence            real,
  approval_state        text NOT NULL DEFAULT 'draft'
                          CONSTRAINT candidate_evaluations_approval_state_check
                          CHECK (approval_state IN ('draft','approved')),
  model                 text,
  generated_by_user_id  text,
  approved_by_user_id   text,
  approved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- Re-runnable on a pre-fix dev table: ensure the id default exists.
ALTER TABLE candidate_evaluations ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- One evaluation per candidate×job (regenerate updates in place).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_evaluation_job_candidate
  ON candidate_evaluations (job_id, candidate_id);
CREATE INDEX IF NOT EXISTS candidate_evaluations_tenant_idx
  ON candidate_evaluations (tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS candidate_evaluations_candidate_idx
  ON candidate_evaluations (candidate_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_evaluations TO lexy_app;

ALTER TABLE candidate_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_evaluations FORCE ROW LEVEL SECURITY;

-- Idempotent re-install of the policies.
DROP POLICY IF EXISTS candidate_evaluations_select ON candidate_evaluations;
DROP POLICY IF EXISTS candidate_evaluations_insert ON candidate_evaluations;
DROP POLICY IF EXISTS candidate_evaluations_update ON candidate_evaluations;
DROP POLICY IF EXISTS candidate_evaluations_delete ON candidate_evaluations;

CREATE POLICY candidate_evaluations_select ON candidate_evaluations
  FOR SELECT TO lexy_app
  USING (app_tenant_in_scope(tenant_id));

CREATE POLICY candidate_evaluations_insert ON candidate_evaluations
  FOR INSERT TO lexy_app
  WITH CHECK (app_tenant_in_scope(tenant_id));

CREATE POLICY candidate_evaluations_update ON candidate_evaluations
  FOR UPDATE TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

CREATE POLICY candidate_evaluations_delete ON candidate_evaluations
  FOR DELETE TO lexy_app
  USING (app_tenant_in_scope(tenant_id));
