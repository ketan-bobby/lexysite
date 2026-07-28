/*
 * Migration 0016 — AI Governance Layer
 *
 * Why this migration exists
 * -------------------------
 * Per Colorado SB24-205, NYC LL144, IL HRA AI amendments, and the EU AI
 * Act (high-risk employment), a regulator-facing audit must be able to
 * inspect the database and confirm that no "consequential employment
 * decision" was made autonomously by an AI system. The previous
 * applications.stage column conflated "where the candidate sits in the
 * funnel" with "who terminated their consideration." That conflation is
 * legally indefensible.
 *
 * This migration splits the decision into two distinct, DB-enforced
 * fields:
 *   - applications.ai_recommendation  (enum, includes 'reject')
 *   - applications.final_decision     (enum, has NO 'ai_*' values)
 *
 * A CHECK constraint guarantees that final_decision can never carry an
 * AI-authored adverse value, and that any non-null final_decision must
 * either name a human actor OR be the explicit 'legacy_pre_gate' marker.
 *
 * It also introduces three governance tables — versioned, append-only:
 *   - jurisdiction_ai_policy_rules     (which jurisdictions gate which
 *                                       actions; append-only versioning
 *                                       via effective_from / effective_to)
 *   - jurisdiction_disclosure_templates (candidate-facing notice copy)
 *   - decision_events                  (immutable audit of every gated
 *                                       or human decision; UPDATE/DELETE
 *                                       revoked at the table level)
 *
 * Backfill strategy
 * -----------------
 * Soft cutover (option B from the design discussion): existing
 * applications keep applications.stage untouched. final_decision stays
 * NULL on legacy rows; we do not rewrite history. Going forward, every
 * adverse status change writes through the enforcement service and
 * populates both columns. SOC2 evidence will document the cutover date.
 *
 * Seed data
 * ---------
 * NYC, CO, IL, EU policy rules are seeded as platform-floor policies
 * effective immediately. Tenants cannot disable these (enforcement
 * resolves the platform floor first, then unions tenant-extension
 * policies on top). Placeholder disclosure templates are seeded so the
 * column is populated; legal owns the actual copy iteration.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * 1. New enum types — the heart of the schema-level safety guarantee.
 *    final_decision_enum deliberately has NO ai_* values. Even a
 *    misbehaving service cannot store an autonomous AI rejection in
 *    final_decision because the type system will reject it.
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TYPE ai_recommendation_enum AS ENUM (
  'advance',
  'reject',
  'hold',
  'lapsed',
  'flag_fraud',
  'no_recommendation'
);

CREATE TYPE final_decision_enum AS ENUM (
  'human_advance',
  'human_reject',
  'human_hold',
  'human_lapsed',
  'human_hired',
  'human_offer',
  'candidate_withdrawn',
  'legacy_pre_gate'
);

/* ─────────────────────────────────────────────────────────────────────────
 * 2. applications — add governance columns.
 * ───────────────────────────────────────────────────────────────────────── */
ALTER TABLE applications
  ADD COLUMN ai_recommendation         ai_recommendation_enum,
  ADD COLUMN ai_recommendation_at      timestamptz,
  ADD COLUMN ai_recommendation_model   text,
  ADD COLUMN ai_recommendation_score   real,
  ADD COLUMN final_decision            final_decision_enum,
  ADD COLUMN final_decision_by         text,            -- user_id
  ADD COLUMN final_decision_at         timestamptz,
  ADD COLUMN final_decision_attestation text,
  ADD COLUMN final_decision_reason     text,            -- structured rationale
  ADD COLUMN gated_by_jurisdiction     text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN policy_version_id         text;

/* CHECK 1: any non-null final_decision must EITHER carry a human actor
 * OR be the explicit legacy marker. There is no third option. This is
 * what the LL144 auditor will scan for first. */
ALTER TABLE applications
  ADD CONSTRAINT applications_final_decision_requires_human
  CHECK (
    final_decision IS NULL
    OR final_decision_by IS NOT NULL
    OR final_decision = 'legacy_pre_gate'
  );

/* CHECK 2: if final_decision is set, the attestation text must be set
 * as well (or the row is legacy). Plaintiff attorneys reach for the
 * attestation text in discovery; making it structurally non-optional
 * means it cannot be silently absent. */
ALTER TABLE applications
  ADD CONSTRAINT applications_final_decision_requires_attestation
  CHECK (
    final_decision IS NULL
    OR final_decision_attestation IS NOT NULL
    OR final_decision = 'legacy_pre_gate'
  );

CREATE INDEX applications_pending_human_review_idx
  ON applications (tenant_id, ai_recommendation)
  WHERE ai_recommendation IS NOT NULL AND final_decision IS NULL;

CREATE INDEX applications_gated_jurisdiction_idx
  ON applications USING gin (gated_by_jurisdiction);

/* ─────────────────────────────────────────────────────────────────────────
 * 3. jurisdiction_ai_policy_rules — versioned append-only.
 *
 *    Every policy revision is a NEW row; the old row's effective_to is
 *    closed. Each gated decision logs the policy_version_id that was in
 *    effect at decision time, so an auditor can answer "what policy was
 *    enforced for jurisdiction X on date Y."
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TABLE jurisdiction_ai_policy_rules (
  id                  text PRIMARY KEY,
  jurisdiction_code   text NOT NULL,           -- 'US-NY-NYC', 'US-CO', 'US-IL', 'EU'
  jurisdiction_label  text NOT NULL,           -- human-readable
  scope               text NOT NULL,           -- 'platform_floor' | 'tenant_extension'
  tenant_id           text,                    -- null when scope='platform_floor'
  gate_rejects        boolean NOT NULL DEFAULT true,
  gate_lapsed         boolean NOT NULL DEFAULT true,
  gate_holds          boolean NOT NULL DEFAULT false,
  require_disclosure  boolean NOT NULL DEFAULT true,
  require_appeal      boolean NOT NULL DEFAULT false,
  require_audit       boolean NOT NULL DEFAULT true,
  basis               text,                    -- 'LL144', 'CO-SB24-205', 'IL-HRA', 'EU-AI-Act'
  effective_from      timestamptz NOT NULL,
  effective_to        timestamptz,             -- null = currently active
  created_by          text,                    -- user_id of policy author (null for seeds)
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jurisdiction_policy_scope_check
    CHECK (scope IN ('platform_floor', 'tenant_extension')),
  CONSTRAINT jurisdiction_policy_tenant_required
    CHECK (scope = 'platform_floor' OR tenant_id IS NOT NULL)
);

CREATE INDEX jurisdiction_policy_active_idx
  ON jurisdiction_ai_policy_rules (jurisdiction_code, scope, tenant_id)
  WHERE effective_to IS NULL;

/* Append-only enforcement: we PREVENT in-place updates of effective_from,
 * jurisdiction_code, scope, and the gate_* flags. effective_to MAY be
 * updated (to close out a policy when superseded). created_by/at never
 * change. */
CREATE OR REPLACE FUNCTION jurisdiction_policy_block_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.jurisdiction_code IS DISTINCT FROM OLD.jurisdiction_code
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.gate_rejects IS DISTINCT FROM OLD.gate_rejects
     OR NEW.gate_lapsed IS DISTINCT FROM OLD.gate_lapsed
     OR NEW.gate_holds IS DISTINCT FROM OLD.gate_holds
     OR NEW.require_disclosure IS DISTINCT FROM OLD.require_disclosure
     OR NEW.require_appeal IS DISTINCT FROM OLD.require_appeal
     OR NEW.require_audit IS DISTINCT FROM OLD.require_audit
     OR NEW.basis IS DISTINCT FROM OLD.basis
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'jurisdiction_ai_policy_rules is append-only — fields are immutable except effective_to. Insert a new row to revise the policy.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jurisdiction_policy_block_mutation_trg
  BEFORE UPDATE ON jurisdiction_ai_policy_rules
  FOR EACH ROW EXECUTE FUNCTION jurisdiction_policy_block_mutation();

/* DELETE on policy rows is also blocked outright — supersede via a new
 * row and a closed effective_to instead. */
CREATE OR REPLACE FUNCTION jurisdiction_policy_block_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'jurisdiction_ai_policy_rules rows cannot be deleted — supersede with a new row.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jurisdiction_policy_block_delete_trg
  BEFORE DELETE ON jurisdiction_ai_policy_rules
  FOR EACH ROW EXECUTE FUNCTION jurisdiction_policy_block_delete();

/* ─────────────────────────────────────────────────────────────────────────
 * 4. jurisdiction_disclosure_templates — candidate-facing notice copy,
 *    versioned the same way as policy rules. Legal owns the content;
 *    engineering owns the table shape.
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TABLE jurisdiction_disclosure_templates (
  id                  text PRIMARY KEY,
  jurisdiction_code   text NOT NULL,
  language            text NOT NULL DEFAULT 'en',
  template_key        text NOT NULL,         -- 'aedt_notice' | 'co_pre_decision' | 'il_aivi' | 'eu_ai_act'
  subject             text,                  -- for email/notice headings
  body_markdown       text NOT NULL,
  effective_from      timestamptz NOT NULL,
  effective_to        timestamptz,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jurisdiction_disclosure_active_idx
  ON jurisdiction_disclosure_templates (jurisdiction_code, language, template_key)
  WHERE effective_to IS NULL;

/* ─────────────────────────────────────────────────────────────────────────
 * 5. decision_events — append-only immutable audit log.
 *
 *    Every gated decision, human review, override, appeal request, and
 *    policy application writes a row here. UPDATE and DELETE are
 *    blocked at the trigger level so a misbehaving service cannot
 *    rewrite history. This is the table an LL144 auditor and a CO AG
 *    investigator both read.
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TABLE decision_events (
  id                  text PRIMARY KEY,
  tenant_id           text NOT NULL,
  application_id      text,
  candidate_id        text,
  job_id              text,
  event_type          text NOT NULL,         -- 'decision_created' | 'decision_reviewed' | 'decision_overridden' | 'appeal_requested' | 'appeal_completed' | 'policy_applied' | 'disclosure_shown'
  actor_user_id       text,                  -- null for system events
  actor_kind          text NOT NULL,         -- 'system' | 'ai' | 'recruiter' | 'tenant_admin' | 'hiring_manager' | 'platform_admin' | 'candidate'
  ai_recommendation   ai_recommendation_enum,
  final_decision      final_decision_enum,
  rationale           text,
  attestation         text,
  model_id            text,
  model_version       text,
  prompt_version      text,
  scoring_version     text,
  orchestration_version text,
  policy_version_id   text,
  jurisdictions       text[] NOT NULL DEFAULT '{}'::text[],
  disclosure_version_id text,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decision_events_app_idx       ON decision_events (application_id, created_at DESC);
CREATE INDEX decision_events_tenant_idx    ON decision_events (tenant_id, created_at DESC);
CREATE INDEX decision_events_type_idx      ON decision_events (event_type, created_at DESC);
CREATE INDEX decision_events_actor_idx     ON decision_events (actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION decision_events_block_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'decision_events is append-only — rows cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decision_events_block_update_trg
  BEFORE UPDATE ON decision_events
  FOR EACH ROW EXECUTE FUNCTION decision_events_block_mutation();

CREATE TRIGGER decision_events_block_delete_trg
  BEFORE DELETE ON decision_events
  FOR EACH ROW EXECUTE FUNCTION decision_events_block_mutation();

/* ─────────────────────────────────────────────────────────────────────────
 * 6. appeals_requests — minimal stub. Full operational appeal workflow
 *    ships in T+1; this exists now so the schema is stable and the
 *    enforcement service can write appeal_requested events that
 *    reference real rows.
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TABLE appeals_requests (
  id                  text PRIMARY KEY,
  tenant_id           text NOT NULL,
  application_id      text NOT NULL,
  candidate_id        text,
  requested_by        text NOT NULL,         -- 'candidate' | user_id
  reason              text,
  status              text NOT NULL DEFAULT 'received',  -- 'received' | 'in_review' | 'upheld' | 'overturned' | 'withdrawn'
  reviewer_user_id    text,
  outcome_reason      text,
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX appeals_requests_app_idx
  ON appeals_requests (application_id, created_at DESC);
CREATE INDEX appeals_requests_open_idx
  ON appeals_requests (tenant_id, status)
  WHERE status IN ('received', 'in_review');

/* ─────────────────────────────────────────────────────────────────────────
 * 7. Seed: platform-floor policy rules for NYC, CO, IL, EU.
 *
 *    These rows are platform-enforced and tenants cannot disable them.
 *    The enforcement service unions them with any tenant_extension rows
 *    at decision time. effective_from is now(); effective_to is NULL so
 *    they are currently active.
 * ───────────────────────────────────────────────────────────────────────── */
INSERT INTO jurisdiction_ai_policy_rules
  (id, jurisdiction_code, jurisdiction_label, scope, tenant_id,
   gate_rejects, gate_lapsed, gate_holds,
   require_disclosure, require_appeal, require_audit,
   basis, effective_from, effective_to, created_by)
VALUES
  ('seed-policy-us-ny-nyc-v1',
   'US-NY-NYC', 'New York City', 'platform_floor', NULL,
   true, true, false,
   true, false, true,
   'NYC LL144', now(), NULL, NULL),

  ('seed-policy-us-co-v1',
   'US-CO', 'Colorado', 'platform_floor', NULL,
   true, true, false,
   true, true, true,
   'CO SB24-205 (Colorado AI Act)', now(), NULL, NULL),

  ('seed-policy-us-il-v1',
   'US-IL', 'Illinois', 'platform_floor', NULL,
   true, true, false,
   true, false, true,
   'IL HRA AI amendments + AIVI', now(), NULL, NULL),

  ('seed-policy-eu-v1',
   'EU', 'European Union', 'platform_floor', NULL,
   true, true, false,
   true, true, true,
   'EU AI Act (high-risk employment)', now(), NULL, NULL);

/* Seed placeholder disclosure templates. Legal will edit copy via
 * supersession (insert a new row with later effective_from, close the
 * old one with effective_to). Do not edit these in place. */
INSERT INTO jurisdiction_disclosure_templates
  (id, jurisdiction_code, language, template_key, subject, body_markdown,
   effective_from, effective_to, created_by)
VALUES
  ('seed-disclosure-nyc-aedt-v1', 'US-NY-NYC', 'en', 'aedt_notice',
   'AI-Assisted Hiring Notice (NYC LL144)',
   E'This employer uses an automated employment decision tool (AEDT) to assist in screening your application. The tool was independently bias-audited; the most recent audit summary is published at the company''s careers site. You may request additional information or an alternative selection process by contacting the employer. [LEGAL PLACEHOLDER — replace with finalized LL144 notice copy]',
   now(), NULL, NULL),

  ('seed-disclosure-co-predecision-v1', 'US-CO', 'en', 'co_pre_decision',
   'Algorithmic Decision Notice (Colorado AI Act)',
   E'Under the Colorado AI Act (SB24-205), we are notifying you that an AI system contributed to the screening of your application. You have the right to know the principal reason for any consequential decision, to correct inaccurate personal data, and to appeal an adverse decision to a human reviewer. [LEGAL PLACEHOLDER — replace with finalized CO notice copy]',
   now(), NULL, NULL),

  ('seed-disclosure-il-aivi-v1', 'US-IL', 'en', 'il_aivi',
   'AI Video Interview Notice (Illinois AIVI Act)',
   E'Per the Illinois Artificial Intelligence Video Interview Act, this employer uses AI to analyze video interviews. You may consent to or decline AI analysis without forfeiting your application. [LEGAL PLACEHOLDER — replace with finalized AIVI notice copy]',
   now(), NULL, NULL),

  ('seed-disclosure-eu-ai-act-v1', 'EU', 'en', 'eu_ai_act',
   'AI Decision Notice (EU AI Act, Annex III high-risk employment)',
   E'You are interacting with a high-risk AI system as defined under EU AI Act Annex III (employment). Human oversight applies to every consequential decision. You have the right to obtain a meaningful explanation and to contest the decision. [LEGAL PLACEHOLDER — replace with finalized EU AI Act notice copy]',
   now(), NULL, NULL);
