BEGIN;

ALTER TABLE candidates
  ADD CONSTRAINT candidates_id_tenant_unique UNIQUE (id, tenant_id);

CREATE TABLE candidate_learning_profiles (
  id text PRIMARY KEY,
  candidate_id text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  interests jsonb,
  immediate_goal text,
  confirmed_career_goal_3yr text,
  confirmed_career_goal_5yr text,
  goals_confirmed_at timestamp with time zone,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_learning_profiles_candidate_tenant_fk
    FOREIGN KEY (candidate_id, tenant_id)
    REFERENCES candidates (id, tenant_id)
    ON DELETE CASCADE,
  CONSTRAINT candidate_learning_profiles_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (id)
    ON DELETE CASCADE,
  CONSTRAINT candidate_learning_profiles_revision_nonnegative_chk
    CHECK (revision >= 0),
  CONSTRAINT candidate_learning_profiles_immediate_goal_length_chk
    CHECK (immediate_goal IS NULL OR (char_length(immediate_goal) BETWEEN 1 AND 2000)),
  CONSTRAINT candidate_learning_profiles_goal_3yr_length_chk
    CHECK (confirmed_career_goal_3yr IS NULL OR (char_length(confirmed_career_goal_3yr) BETWEEN 1 AND 2000)),
  CONSTRAINT candidate_learning_profiles_goal_5yr_length_chk
    CHECK (confirmed_career_goal_5yr IS NULL OR (char_length(confirmed_career_goal_5yr) BETWEEN 1 AND 2000)),
  CONSTRAINT candidate_learning_profiles_confirmation_complete_chk
    CHECK (
      goals_confirmed_at IS NULL
      OR (
        immediate_goal IS NOT NULL
        AND confirmed_career_goal_3yr IS NOT NULL
        AND confirmed_career_goal_5yr IS NOT NULL
      )
    ),
  CONSTRAINT candidate_learning_profiles_interests_object_chk
    CHECK (interests IS NULL OR jsonb_typeof(interests) = 'object')
);

CREATE INDEX candidate_learning_profiles_tenant_candidate_idx
  ON candidate_learning_profiles (tenant_id, candidate_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_learning_profiles TO lexy_app;

ALTER TABLE candidate_learning_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_learning_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY candidate_learning_profiles_tenant_select
  ON candidate_learning_profiles
  FOR SELECT TO lexy_app
  USING (app_tenant_in_scope(tenant_id));

CREATE POLICY candidate_learning_profiles_tenant_insert
  ON candidate_learning_profiles
  FOR INSERT TO lexy_app
  WITH CHECK (app_tenant_in_scope(tenant_id));

CREATE POLICY candidate_learning_profiles_tenant_update
  ON candidate_learning_profiles
  FOR UPDATE TO lexy_app
  USING (app_tenant_in_scope(tenant_id))
  WITH CHECK (app_tenant_in_scope(tenant_id));

CREATE POLICY candidate_learning_profiles_tenant_delete
  ON candidate_learning_profiles
  FOR DELETE TO lexy_app
  USING (app_tenant_in_scope(tenant_id));

COMMIT;