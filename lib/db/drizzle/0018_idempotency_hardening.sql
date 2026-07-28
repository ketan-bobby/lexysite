/*
 * Migration 0018 — Idempotency hardening for T011n review fallout.
 *
 * The architect re-review of T011 found three race / duplication
 * hazards that the application code alone cannot close:
 *
 *  1. candidate_disclosure_acks had no server-side dedupe key, so a
 *     double-click or multi-device retry could insert several rows
 *     for what is conceptually a single act of notice. The localStorage
 *     suppression on the client is convenience, not integrity. We add
 *     a deterministic `ack_key` column + unique index so the second
 *     write becomes a no-op at the database level.
 *
 *  2. stripe_processed_events tracked only "have we ever seen this
 *     event id?" — there was no distinction between "received" and
 *     "fully processed". A handler failure after the ledger insert
 *     would cause the Stripe retry to short-circuit on the duplicate
 *     id without ever re-running the side effects. We add
 *     `processed_at` (nullable). The handler claims the row (insert
 *     with processed_at=NULL or detect a stale claim), runs side
 *     effects, then UPDATEs processed_at=now() on success or DELETEs
 *     the row on failure so Stripe's retry will re-claim.
 *
 *  3. appeals_requests resolve previously relied on a precheck +
 *     unconditional UPDATE pattern that two concurrent reviewers
 *     could both pass, producing duplicate decision_event rows and
 *     potentially double-flipping the final_decision. No schema
 *     change is required — the application code now uses an atomic
 *     conditional UPDATE (`WHERE id=? AND resolved_at IS NULL
 *     RETURNING id`) which the existing primary key already
 *     serialises correctly. This migration is the audit pin: if the
 *     resolve route is later weakened, the constraint added below
 *     ensures a resolved row cannot be re-resolved with a different
 *     attestation.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * 1. candidate_disclosure_acks — server-side idempotency key.
 *
 * The application computes ack_key as
 *
 *   sha256(candidate_id || '\x1f' || surface || '\x1f' ||
 *          sort(template_ids).join(',') || '\x1f' ||
 *          sort(policy_version_ids).join(','))
 *
 * so the same candidate acknowledging the same bundle on the same
 * surface produces the same key. Different surfaces (banner vs AEDT
 * notice page) still get distinct rows — the regulator wants to see
 * each moment of notice independently per the disclosures route
 * docstring.
 *
 * Backfill: legacy rows get NULL ack_key. The unique index is
 * partial WHERE ack_key IS NOT NULL so it doesn't reject the
 * legacy data. New writes always supply the key.
 * ───────────────────────────────────────────────────────────────────────── */
ALTER TABLE candidate_disclosure_acks
  ADD COLUMN IF NOT EXISTS ack_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_disclosure_acks_ack_key
  ON candidate_disclosure_acks (ack_key)
  WHERE ack_key IS NOT NULL;

/* ─────────────────────────────────────────────────────────────────────────
 * 2. stripe_processed_events — two-phase processing flag.
 *
 * processed_at IS NULL          → claim in flight (or failed mid-handler).
 *                                 A Stripe retry must be allowed to
 *                                 re-attempt. The application code does
 *                                 this by DELETEing the row when its
 *                                 handler throws.
 * processed_at IS NOT NULL      → fully handled, side effects committed.
 *                                 Retries short-circuit with 200.
 *
 * `claimed_at` lets a future watchdog reap orphaned claims that the
 * application crashed in the middle of — not used yet but cheaper to
 * add the column now than alter a hot table later.
 * ───────────────────────────────────────────────────────────────────────── */
ALTER TABLE stripe_processed_events
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at   timestamptz NOT NULL DEFAULT now();

/* Existing rows were inserted under the old "insert == processed"
 * convention; backfill them to fully-processed so legacy traffic is
 * never re-run. */
UPDATE stripe_processed_events
   SET processed_at = received_at
 WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_processed_events_unprocessed
  ON stripe_processed_events (claimed_at)
  WHERE processed_at IS NULL;

/* ─────────────────────────────────────────────────────────────────────────
 * 3. appeals_requests — guard against double-resolution.
 *
 * The CHECK below is intentionally narrow: once `resolved_at` is set
 * and `reviewer_attestation` recorded, those columns cannot change.
 * It does NOT prevent two concurrent UPDATEs from racing on a still-
 * open row — that's the application's job via conditional UPDATE.
 * What it does prevent is the post-resolution silent overwrite that a
 * future refactor might accidentally introduce.
 *
 * Implemented as a BEFORE UPDATE trigger because Postgres CHECK
 * constraints cannot reference OLD/NEW. Pattern matches the
 * admin_impersonation_sessions trigger from migration 0017.
 * ───────────────────────────────────────────────────────────────────────── */
CREATE OR REPLACE FUNCTION appeals_requests_block_post_resolution_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL THEN
    IF (OLD.resolved_at IS DISTINCT FROM NEW.resolved_at)
       OR (OLD.outcome IS DISTINCT FROM NEW.outcome)
       OR (OLD.reviewer_user_id IS DISTINCT FROM NEW.reviewer_user_id)
       OR (OLD.reviewer_attestation IS DISTINCT FROM NEW.reviewer_attestation)
       OR (OLD.status IS DISTINCT FROM NEW.status)
    THEN
      RAISE EXCEPTION 'appeals_requests row % already resolved; resolution columns are immutable', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appeals_requests_no_post_resolution_edit ON appeals_requests;
CREATE TRIGGER appeals_requests_no_post_resolution_edit
  BEFORE UPDATE ON appeals_requests
  FOR EACH ROW EXECUTE FUNCTION appeals_requests_block_post_resolution_edit();

/* ─── Forward-fix notes ────────────────────────────────────────────────────
 * Rollback policy is forward-only (see docs/RUNBOOK_PROD_MIGRATIONS.md).
 * If the trigger above proves too strict (e.g. a regulator-mandated
 * correction to attestation text), write a new migration that DROPs
 * the trigger, applies the surgical edit via a one-off script logged
 * as a decision_event, and re-CREATEs the trigger.
 */
