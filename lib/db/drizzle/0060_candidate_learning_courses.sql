BEGIN;

CREATE TABLE IF NOT EXISTS candidate_learning_enrollments (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  tenant_id text NOT NULL,
  course_id text NOT NULL,
  course_version integer NOT NULL,
  path text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  enrolled_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_enrollments_candidate_tenant_fk
    FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_enrollments_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_enrollments_version_positive_chk CHECK (course_version > 0),
  CONSTRAINT candidate_learning_enrollments_path_chk CHECK (path IN ('voice', 'chat_email')),
  CONSTRAINT candidate_learning_enrollments_status_chk CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT candidate_learning_enrollments_completion_chk
    CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR (status = 'in_progress' AND completed_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_enrollments_candidate_course_uidx
  ON candidate_learning_enrollments (candidate_id, course_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_enrollments_id_tenant_uidx
  ON candidate_learning_enrollments (id, tenant_id);
CREATE INDEX IF NOT EXISTS candidate_learning_enrollments_tenant_candidate_idx
  ON candidate_learning_enrollments (tenant_id, candidate_id);

CREATE TABLE IF NOT EXISTS candidate_learning_lesson_progress (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL,
  candidate_id text NOT NULL,
  tenant_id text NOT NULL,
  lesson_id text NOT NULL,
  course_version integer NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_lesson_progress_enrollment_tenant_fk
    FOREIGN KEY (enrollment_id, tenant_id) REFERENCES candidate_learning_enrollments (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_lesson_progress_candidate_tenant_fk
    FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_lesson_progress_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_lesson_progress_version_positive_chk CHECK (course_version > 0),
  CONSTRAINT candidate_learning_lesson_progress_revision_nonnegative_chk CHECK (revision >= 0),
  CONSTRAINT candidate_learning_lesson_progress_attempts_nonnegative_chk CHECK (attempts >= 0),
  CONSTRAINT candidate_learning_lesson_progress_status_chk CHECK (status IN ('draft', 'completed')),
  CONSTRAINT candidate_learning_lesson_progress_answers_object_chk CHECK (jsonb_typeof(answers) = 'object'),
  CONSTRAINT candidate_learning_lesson_progress_feedback_array_chk CHECK (jsonb_typeof(feedback) = 'array'),
  CONSTRAINT candidate_learning_lesson_progress_completion_chk
    CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR (status = 'draft' AND completed_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_lesson_progress_enrollment_lesson_uidx
  ON candidate_learning_lesson_progress (enrollment_id, lesson_id);
CREATE INDEX IF NOT EXISTS candidate_learning_lesson_progress_tenant_candidate_idx
  ON candidate_learning_lesson_progress (tenant_id, candidate_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_enrollments TO lexy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_lesson_progress TO lexy_app;

ALTER TABLE candidate_learning_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_lesson_progress FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS candidate_learning_enrollments_tenant_select ON candidate_learning_enrollments;
CREATE POLICY candidate_learning_enrollments_tenant_select ON candidate_learning_enrollments
  FOR SELECT TO lexy_app USING (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_enrollments_tenant_insert ON candidate_learning_enrollments;
CREATE POLICY candidate_learning_enrollments_tenant_insert ON candidate_learning_enrollments
  FOR INSERT TO lexy_app WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_enrollments_tenant_update ON candidate_learning_enrollments;
CREATE POLICY candidate_learning_enrollments_tenant_update ON candidate_learning_enrollments
  FOR UPDATE TO lexy_app USING (app_tenant_in_scope(tenant_id)) WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_enrollments_tenant_delete ON candidate_learning_enrollments;
CREATE POLICY candidate_learning_enrollments_tenant_delete ON candidate_learning_enrollments
  FOR DELETE TO lexy_app USING (app_tenant_in_scope(tenant_id));

DROP POLICY IF EXISTS candidate_learning_lesson_progress_tenant_select ON candidate_learning_lesson_progress;
CREATE POLICY candidate_learning_lesson_progress_tenant_select ON candidate_learning_lesson_progress
  FOR SELECT TO lexy_app USING (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_lesson_progress_tenant_insert ON candidate_learning_lesson_progress;
CREATE POLICY candidate_learning_lesson_progress_tenant_insert ON candidate_learning_lesson_progress
  FOR INSERT TO lexy_app WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_lesson_progress_tenant_update ON candidate_learning_lesson_progress;
CREATE POLICY candidate_learning_lesson_progress_tenant_update ON candidate_learning_lesson_progress
  FOR UPDATE TO lexy_app USING (app_tenant_in_scope(tenant_id)) WITH CHECK (app_tenant_in_scope(tenant_id));
DROP POLICY IF EXISTS candidate_learning_lesson_progress_tenant_delete ON candidate_learning_lesson_progress;
CREATE POLICY candidate_learning_lesson_progress_tenant_delete ON candidate_learning_lesson_progress
  FOR DELETE TO lexy_app USING (app_tenant_in_scope(tenant_id));

COMMIT;

-- rollback: never roll back in production; use a forward migration to disable access or correct this additive schema.