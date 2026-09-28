BEGIN;

CREATE TABLE IF NOT EXISTS candidate_learning_voice_cycles (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  tenant_id text NOT NULL,
  course_id text NOT NULL,
  course_version integer NOT NULL,
  comparison_family_version text NOT NULL,
  rubric_version text NOT NULL,
  evaluator_version text NOT NULL,
  state text NOT NULL DEFAULT 'baseline_draft',
  baseline_snapshot jsonb,
  progress_snapshot jsonb,
  comparison_snapshot jsonb,
  baseline_completed_at timestamp with time zone,
  progress_started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_voice_cycles_candidate_tenant_fk
    FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_voice_cycles_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_voice_cycles_course_version_chk CHECK (course_version > 0),
  CONSTRAINT candidate_learning_voice_cycles_state_chk CHECK (state IN ('baseline_draft', 'training', 'progress_draft', 'completed')),
  CONSTRAINT candidate_learning_voice_cycles_snapshot_chk CHECK (
    (state = 'baseline_draft' AND baseline_completed_at IS NULL AND completed_at IS NULL)
    OR (state = 'training' AND baseline_completed_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'progress_draft' AND baseline_completed_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND baseline_completed_at IS NOT NULL AND completed_at IS NOT NULL
      AND baseline_snapshot IS NOT NULL AND progress_snapshot IS NOT NULL AND comparison_snapshot IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_voice_cycles_id_tenant_uidx
  ON candidate_learning_voice_cycles (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_voice_cycles_id_candidate_tenant_uidx
  ON candidate_learning_voice_cycles (id, candidate_id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_voice_cycles_candidate_course_active_uidx
  ON candidate_learning_voice_cycles (candidate_id, course_id) WHERE state <> 'completed';
CREATE INDEX IF NOT EXISTS candidate_learning_voice_cycles_tenant_candidate_idx
  ON candidate_learning_voice_cycles (tenant_id, candidate_id);

CREATE TABLE IF NOT EXISTS candidate_learning_voice_turns (
  id text PRIMARY KEY,
  cycle_id text NOT NULL,
  candidate_id text NOT NULL,
  tenant_id text NOT NULL,
  phase text NOT NULL,
  form text NOT NULL,
  task_key text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  response text NOT NULL DEFAULT '',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_voice_turns_cycle_tenant_fk
    FOREIGN KEY (cycle_id, tenant_id) REFERENCES candidate_learning_voice_cycles (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_voice_turns_cycle_owner_fk
    FOREIGN KEY (cycle_id, candidate_id, tenant_id) REFERENCES candidate_learning_voice_cycles (id, candidate_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_voice_turns_candidate_tenant_fk
    FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_voice_turns_phase_chk CHECK (phase IN ('baseline', 'progress')),
  CONSTRAINT candidate_learning_voice_turns_form_chk CHECK (form IN ('A', 'B')),
  CONSTRAINT candidate_learning_voice_turns_revision_chk CHECK (revision >= 0),
  CONSTRAINT candidate_learning_voice_turns_status_chk CHECK (status IN ('draft', 'submitted')),
  CONSTRAINT candidate_learning_voice_turns_response_length_chk CHECK (char_length(response) <= 6000)
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_voice_turns_cycle_phase_task_uidx
  ON candidate_learning_voice_turns (cycle_id, phase, task_key);
CREATE INDEX IF NOT EXISTS candidate_learning_voice_turns_tenant_candidate_idx
  ON candidate_learning_voice_turns (tenant_id, candidate_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_voice_cycles TO lexy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_voice_turns TO lexy_app;
ALTER TABLE candidate_learning_voice_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_voice_cycles FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_voice_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_voice_turns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_select ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_select ON candidate_learning_voice_cycles FOR SELECT TO lexy_app USING (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_insert ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_insert ON candidate_learning_voice_cycles FOR INSERT TO lexy_app WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_update ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_update ON candidate_learning_voice_cycles FOR UPDATE TO lexy_app USING (app_tenant_in_scope(tenant_id)) WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_voice_cycles_tenant_delete ON candidate_learning_voice_cycles;
CREATE POLICY candidate_learning_voice_cycles_tenant_delete ON candidate_learning_voice_cycles FOR DELETE TO lexy_app USING (app_tenant_in_scope(tenant_id));

DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_select ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_select ON candidate_learning_voice_turns FOR SELECT TO lexy_app USING (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_insert ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_insert ON candidate_learning_voice_turns FOR INSERT TO lexy_app WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_update ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_update ON candidate_learning_voice_turns FOR UPDATE TO lexy_app USING (app_tenant_in_scope(tenant_id)) WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_voice_turns_tenant_delete ON candidate_learning_voice_turns;
CREATE POLICY candidate_learning_voice_turns_tenant_delete ON candidate_learning_voice_turns FOR DELETE TO lexy_app USING (app_tenant_in_scope(tenant_id));

COMMIT;