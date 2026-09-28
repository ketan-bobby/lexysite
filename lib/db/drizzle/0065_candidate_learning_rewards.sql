BEGIN;

ALTER TABLE candidate_learning_voice_cycles
  DROP CONSTRAINT IF EXISTS candidate_learning_voice_cycles_training_evidence_chk;
ALTER TABLE candidate_learning_voice_cycles
  ADD CONSTRAINT candidate_learning_voice_cycles_training_evidence_chk CHECK (
    (training_completed_at IS NULL AND training_evidence IS NULL)
    OR (state IN ('training', 'progress_draft', 'completed') AND training_completed_at IS NOT NULL
      AND training_evidence IN ('enrollment_completion', 'candidate_confirmed_review', 'tracked_review_attempt'))
  );

CREATE TABLE IF NOT EXISTS candidate_learning_course_review_attempts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  candidate_id text NOT NULL,
  cycle_id text NOT NULL,
  course_id text NOT NULL,
  course_version integer NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_course_review_attempts_candidate_tenant_fk FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_course_review_attempts_cycle_owner_fk FOREIGN KEY (cycle_id, candidate_id, tenant_id) REFERENCES candidate_learning_voice_cycles (id, candidate_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_course_review_attempts_status_chk CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT candidate_learning_course_review_attempts_version_chk CHECK (course_version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_course_review_attempts_cycle_uidx ON candidate_learning_course_review_attempts (cycle_id);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_course_review_attempts_id_owner_uidx ON candidate_learning_course_review_attempts (id, candidate_id, tenant_id);

CREATE TABLE IF NOT EXISTS candidate_learning_course_review_lessons (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  candidate_id text NOT NULL,
  attempt_id text NOT NULL,
  lesson_id text NOT NULL,
  reviewed_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_course_review_lessons_attempt_owner_fk FOREIGN KEY (attempt_id, candidate_id, tenant_id) REFERENCES candidate_learning_course_review_attempts (id, candidate_id, tenant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_course_review_lessons_attempt_lesson_uidx ON candidate_learning_course_review_lessons (attempt_id, lesson_id);

CREATE TABLE IF NOT EXISTS candidate_learning_reward_ledger (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  candidate_id text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  badge_key text,
  credits_delta integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  earned_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_reward_ledger_candidate_tenant_fk FOREIGN KEY (candidate_id, tenant_id) REFERENCES candidates (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT candidate_learning_reward_ledger_event_type_chk CHECK (event_type IN ('first_completed_course', 'completed_course', 'first_completed_assessment', 'completed_voice_growth', 'completed_course_review')),
  CONSTRAINT candidate_learning_reward_ledger_credits_chk CHECK (credits_delta >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_learning_reward_ledger_event_key_uidx ON candidate_learning_reward_ledger (event_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_course_review_attempts TO lexy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_course_review_lessons TO lexy_app;
GRANT SELECT, INSERT ON candidate_learning_reward_ledger TO lexy_app;
REVOKE UPDATE, DELETE ON candidate_learning_reward_ledger FROM lexy_app;
ALTER TABLE candidate_learning_course_review_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_course_review_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_course_review_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_course_review_lessons FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_reward_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_reward_ledger FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION candidate_learning_owner_scope(row_tenant text, row_candidate text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app_tenant_in_scope(row_tenant) AND row_candidate = nullif(current_setting('app.current_candidate_id', true), '')
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['candidate_learning_course_review_attempts', 'candidate_learning_course_review_lessons', 'candidate_learning_reward_ledger'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_owner_select', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id))', table_name || '_owner_select', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_owner_insert', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO lexy_app WITH CHECK (candidate_learning_owner_scope(tenant_id, candidate_id))', table_name || '_owner_insert', table_name);
  END LOOP;
END $$;
CREATE POLICY candidate_learning_course_review_attempts_owner_update ON candidate_learning_course_review_attempts FOR UPDATE TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id)) WITH CHECK (candidate_learning_owner_scope(tenant_id, candidate_id));
CREATE POLICY candidate_learning_course_review_lessons_owner_update ON candidate_learning_course_review_lessons FOR UPDATE TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id)) WITH CHECK (candidate_learning_owner_scope(tenant_id, candidate_id));
CREATE POLICY candidate_learning_course_review_attempts_owner_delete ON candidate_learning_course_review_attempts FOR DELETE TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id));
CREATE POLICY candidate_learning_course_review_lessons_owner_delete ON candidate_learning_course_review_lessons FOR DELETE TO lexy_app USING (candidate_learning_owner_scope(tenant_id, candidate_id));

COMMIT;