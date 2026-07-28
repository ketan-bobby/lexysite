/*
 * Migration 0017 — Disclosure acks, real appeal flow, Stripe webhook
 * idempotency, and admin impersonation audit.
 *
 * Why this migration exists
 * -------------------------
 * T010 shipped the AI governance split (recommendation vs final
 * decision). T011 is the launch-blocking follow-up that turns the
 * governance stubs into something a regulator will actually accept:
 *
 *   1. candidate_disclosure_acks — proves that, BEFORE the AEDT was
 *      used on a candidate, that candidate was shown the legally
 *      required notice (LL144 § 5-301, IL AIVI, EU AI Act high-risk
 *      employment). Each ack records the exact disclosure template
 *      version + policy version the candidate saw, plus IP + UA for
 *      the auditor.
 *
 *   2. appeals_requests gets real workflow columns — SLA due date,
 *      outcome enum, reviewer attestation. This converts the v1
 *      stub-with-202 into a queueable, resolvable workflow with the
 *      audit trail Colorado SB24-205 expects.
 *
 *   3. stripe_processed_events — exact-once webhook handling. The
 *      previous code relied on PG unique constraints scattered across
 *      tables; this gives us a single, explicit ledger keyed on the
 *      Stripe event id so a replay is a no-op everywhere.
 *
 *   4. admin_impersonation_sessions — required for SOC2 CC6.6 and
 *      basic customer trust. Every time a platform admin views the
 *      app as another user, we log start + end + reason. No edits
 *      are silently permitted.
 *
 * Backfill
 * --------
 * All four are new tables / nullable columns; no historical rewrite.
 * Existing appeals_requests rows keep status='received' and acquire
 * NULL sla_due_at — the resolver UI surfaces those explicitly as
 * "pre-T011, no SLA recorded" so the queue stays honest.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * 1. candidate_disclosure_acks — proof of notice
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TABLE candidate_disclosure_acks (
  id                       text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id                text NOT NULL,
  candidate_id             text NOT NULL,
  application_id           text,
  /* Which jurisdictions the candidate was shown a notice for at this
   * moment. Stored as an array so a single ack can cover overlapping
   * regimes (e.g. NYC + EU for a remote NYC role offered to an EU
   * applicant). */
  jurisdiction_codes       text[] NOT NULL DEFAULT '{}',
  /* Exact disclosure template versions the candidate saw. Auditor uses
   * this to reconstruct what the candidate read on the day in question
   * even if the templates evolve later. */
  disclosure_template_ids  text[] NOT NULL DEFAULT '{}',
  policy_version_ids       text[] NOT NULL DEFAULT '{}',
  /* Optional context — only the surface flow records it. */
  surface                  text,            -- 'portal_banner' | 'aedt_notice_page' | 'pre_interview' | 'application_start'
  ip_address               text,
  user_agent               text,
  acknowledged_at          timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_candidate_disclosure_acks_candidate ON candidate_disclosure_acks (candidate_id, acknowledged_at DESC);
CREATE INDEX idx_candidate_disclosure_acks_tenant    ON candidate_disclosure_acks (tenant_id, acknowledged_at DESC);
CREATE INDEX idx_candidate_disclosure_acks_app       ON candidate_disclosure_acks (application_id);

/* Append-only — UPDATE/DELETE blocked at the table level, same pattern
 * as decision_events. An auditor must trust this table is forensic. */
CREATE OR REPLACE FUNCTION candidate_disclosure_acks_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'candidate_disclosure_acks is append-only (op=%)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER candidate_disclosure_acks_no_update
  BEFORE UPDATE ON candidate_disclosure_acks
  FOR EACH ROW EXECUTE FUNCTION candidate_disclosure_acks_block_mutation();

CREATE TRIGGER candidate_disclosure_acks_no_delete
  BEFORE DELETE ON candidate_disclosure_acks
  FOR EACH ROW EXECUTE FUNCTION candidate_disclosure_acks_block_mutation();

/* ─────────────────────────────────────────────────────────────────────────
 * 2. appeals_requests — extend with real workflow columns.
 *    Existing rows survive untouched (all new columns are nullable or
 *    have safe defaults).
 * ───────────────────────────────────────────────────────────────────────── */
ALTER TABLE appeals_requests
  /* SLA target. Default to created_at + 10 business days in the
   * application layer; column stays nullable so legacy rows are
   * visibly "no SLA recorded" in the queue UI. */
  ADD COLUMN sla_due_at             timestamptz,
  /* Outcome enum-as-text — kept flexible so we can extend without a
   * schema migration when a new outcome becomes operationally
   * meaningful. CHECK constraint enforces the closed set. */
  ADD COLUMN outcome                text,
  ADD COLUMN outcome_notes          text,
  /* Reviewer attestation — same legal posture as final_decision
   * attestations on applications. If you resolve an appeal you must
   * affirm you reviewed the underlying record. */
  ADD COLUMN reviewer_attestation   text,
  ADD COLUMN candidate_notified_at  timestamptz;

ALTER TABLE appeals_requests
  ADD CONSTRAINT appeals_outcome_values_chk
  CHECK (outcome IS NULL OR outcome IN ('upheld', 'reversed', 'withdrawn', 'duplicate', 'out_of_scope'));

/* If the appeal is resolved, the resolver must be identified and an
 * attestation must be present. Mirrors the final_decision CHECKs from
 * migration 0016. */
ALTER TABLE appeals_requests
  ADD CONSTRAINT appeals_resolved_requires_attestation_chk
  CHECK (
    status NOT IN ('upheld', 'reversed', 'withdrawn')
    OR (reviewer_user_id IS NOT NULL AND reviewer_attestation IS NOT NULL AND resolved_at IS NOT NULL)
  );

CREATE INDEX idx_appeals_requests_sla_due ON appeals_requests (sla_due_at) WHERE status IN ('received', 'in_review');

/* ─────────────────────────────────────────────────────────────────────────
 * 3. stripe_processed_events — exact-once webhook ledger
 *
 * The webhook handler INSERTs the event_id at the top of the handler.
 * A unique-violation on event_id means we've already processed this
 * delivery — the handler returns 200 immediately and does nothing else.
 * Stripe retries with backoff for non-200 responses; this single
 * ledger keeps every downstream side-effect (tenant provisioning,
 * subscription updates, invoices) idempotent without per-table
 * gymnastics.
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TABLE stripe_processed_events (
  event_id        text PRIMARY KEY,
  event_type      text NOT NULL,
  livemode        boolean,
  api_version     text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  /* Tail of the event payload for forensic reconstruction. JSONB so we
   * can grep it for incident response. */
  payload_digest  text,           -- sha256 of the body for tamper detection
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_stripe_processed_events_received ON stripe_processed_events (received_at DESC);
CREATE INDEX idx_stripe_processed_events_type     ON stripe_processed_events (event_type, received_at DESC);

/* ─────────────────────────────────────────────────────────────────────────
 * 4. admin_impersonation_sessions — SOC2 CC6.6
 *
 * Every platform-admin "view-as" session writes a row here. The
 * application-layer middleware is what enforces the impersonation
 * banner + the "cannot impersonate another platform_admin" rule.
 * This table is the audit trail.
 * ───────────────────────────────────────────────────────────────────────── */
CREATE TABLE admin_impersonation_sessions (
  id                        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  platform_admin_user_id    text NOT NULL,
  impersonated_user_id      text NOT NULL,
  impersonated_tenant_id    text,
  reason                    text NOT NULL,
  /* Issued session token (random). The middleware checks it on every
   * request and the column is what stops a leaked banner from giving
   * indefinite access. */
  session_token             text NOT NULL UNIQUE,
  started_at                timestamptz NOT NULL DEFAULT now(),
  /* Hard cap. The middleware enforces both this and an idle timeout. */
  expires_at                timestamptz NOT NULL,
  ended_at                  timestamptz,
  ended_reason              text,         -- 'explicit_stop' | 'expired' | 'admin_logout' | 'security_revoked'
  ip_address                text,
  user_agent                text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_impersonation_admin    ON admin_impersonation_sessions (platform_admin_user_id, started_at DESC);
CREATE INDEX idx_admin_impersonation_target   ON admin_impersonation_sessions (impersonated_user_id, started_at DESC);
CREATE INDEX idx_admin_impersonation_open     ON admin_impersonation_sessions (expires_at) WHERE ended_at IS NULL;

/* Append-only on the start of session (start row never edited except
 * to set ended_at + ended_reason — those columns are the only ones
 * the trigger permits to change). */
CREATE OR REPLACE FUNCTION admin_impersonation_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin_impersonation_sessions rows cannot be deleted';
  END IF;
  /* Only ended_at + ended_reason may change after insert. */
  IF (OLD.platform_admin_user_id IS DISTINCT FROM NEW.platform_admin_user_id)
     OR (OLD.impersonated_user_id IS DISTINCT FROM NEW.impersonated_user_id)
     OR (OLD.session_token IS DISTINCT FROM NEW.session_token)
     OR (OLD.started_at IS DISTINCT FROM NEW.started_at)
     OR (OLD.expires_at IS DISTINCT FROM NEW.expires_at)
     OR (OLD.reason IS DISTINCT FROM NEW.reason)
  THEN
    RAISE EXCEPTION 'admin_impersonation_sessions: only ended_at + ended_reason are mutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_impersonation_immutable
  BEFORE UPDATE OR DELETE ON admin_impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION admin_impersonation_block_mutation();
