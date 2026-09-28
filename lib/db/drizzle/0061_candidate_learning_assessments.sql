BEGIN;

CREATE TABLE IF NOT EXISTS candidate_learning_assessments (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  tenant_id text NOT NULL,
  course_id text NOT NULL,
  course_version integer NOT NULL,
  path text NOT NULL,
  task_set_version integer NOT NULL,
  rubric_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  report_snapshot jsonb,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_assessments_candidate_tenant_fk
    FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_assessments_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_assessments_version_positive_chk CHECK (course_version > 0),
  CONSTRAINT candidate_learning_assessments_task_version_positive_chk CHECK (task_set_version > 0),
  CONSTRAINT candidate_learning_assessments_path_chk CHECK (path IN ('voice', 'chat_email')),
  CONSTRAINT candidate_learning_assessments_status_chk CHECK (status IN ('draft', 'completed')),
  CONSTRAINT candidate_learning_assessments_report_chk
    CHECK ((status = 'completed' AND completed_at IS NOT NULL AND report_snapshot IS NOT NULL)
      OR (status = 'draft' AND completed_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_assessments_id_tenant_uidx
  ON candidate_learning_assessments (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_assessments_candidate_course_draft_uidx
  ON candidate_learning_assessments (candidate_id, course_id) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS candidate_learning_assessments_tenant_candidate_idx
  ON candidate_learning_assessments (tenant_id, candidate_id);

CREATE TABLE IF NOT EXISTS candidate_learning_assessment_tasks (
  id text PRIMARY KEY,
  assessment_id text NOT NULL,
  candidate_id text NOT NULL,
  tenant_id text NOT NULL,
  task_key text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'not_started',
  response text NOT NULL DEFAULT '',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_assessment_tasks_assessment_tenant_fk
    FOREIGN KEY (assessment_id, tenant_id) REFERENCES candidate_learning_assessments (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_assessment_tasks_candidate_tenant_fk
    FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_assessment_tasks_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_assessment_tasks_revision_nonnegative_chk CHECK (revision >= 0),
  CONSTRAINT candidate_learning_assessment_tasks_status_chk CHECK (status IN ('not_started', 'draft', 'submitted')),
  CONSTRAINT candidate_learning_assessment_tasks_response_length_chk CHECK (char_length(response) <= 6000)
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_assessment_tasks_assessment_task_uidx
  ON candidate_learning_assessment_tasks (assessment_id, task_key);
CREATE INDEX IF NOT EXISTS candidate_learning_assessment_tasks_tenant_candidate_idx
  ON candidate_learning_assessment_tasks (tenant_id, candidate_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_assessments TO lexy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_assessment_tasks TO lexy_app;

ALTER TABLE candidate_learning_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_assessment_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_assessment_tasks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS candidate_learning_assessments_tenant_select ON candidate_learning_assessments;
CREATE POLICY candidate_learning_assessments_tenant_select ON candidate_learning_assessments
  FOR SELECT TO lexy_app USING (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_assessments_tenant_insert ON candidate_learning_assessments;
CREATE POLICY candidate_learning_assessments_tenant_insert ON candidate_learning_assessments
  FOR INSERT TO lexy_app WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_assessments_tenant_update ON candidate_learning_assessments;
CREATE POLICY candidate_learning_assessments_tenant_update ON candidate_learning_assessments
  FOR UPDATE TO lexy_app USING (app_tenant_in_scope(tenant_id)) WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_assessments_tenant_delete ON candidate_learning_assessments;
CREATE POLICY candidate_learning_assessments_tenant_delete ON candidate_learning_assessments
  FOR DELETE TO lexy_app USING (app_tenant_in_scope(tenant_id));

DROP POLICY IF EXISTS candidate_learning_assessment_tasks_tenant_select ON candidate_learning_assessment_tasks;
CREATE POLICY candidate_learning_assessment_tasks_tenant_select ON candidate_learning_assessment_tasks
  FOR SELECT TO lexy_app USING (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_assessment_tasks_tenant_insert ON candidate_learning_assessment_tasks;
CREATE POLICY candidate_learning_assessment_tasks_tenant_insert ON candidate_learning_assessment_tasks
  FOR INSERT TO lexy_app WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_assessment_tasks_tenant_update ON candidate_learning_assessment_tasks;
CREATE POLICY candidate_learning_assessment_tasks_tenant_update ON candidate_learning_assessment_tasks
  FOR UPDATE TO lexy_app USING (app_tenant_in_scope(tenant_id)) WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_assessment_tasks_tenant_delete ON candidate_learning_assessment_tasks;
CREATE POLICY candidate_learning_assessment_tasks_tenant_delete ON candidate_learning_assessment_tasks
  FOR DELETE TO lexy_app USING (app_tenant_in_scope(tenant_id));

COMMIT;