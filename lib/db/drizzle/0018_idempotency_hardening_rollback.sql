/*
 * Migration 0018 ROLLBACK — kept as DOCUMENTATION only.
 *
 * We do not run down migrations in production (see
 * docs/RUNBOOK_PROD_MIGRATIONS.md). This file exists so the auditor
 * can see what would have been reversible:
 *
 *   DROP TRIGGER IF EXISTS appeals_requests_no_post_resolution_edit
 *     ON appeals_requests;
 *   DROP FUNCTION IF EXISTS appeals_requests_block_post_resolution_edit();
 *
 *   DROP INDEX IF EXISTS idx_stripe_processed_events_unprocessed;
 *   ALTER TABLE stripe_processed_events
 *     DROP COLUMN IF EXISTS processed_at,
 *     DROP COLUMN IF EXISTS claimed_at;
 *
 *   DROP INDEX IF EXISTS idx_candidate_disclosure_acks_ack_key;
 *   ALTER TABLE candidate_disclosure_acks
 *     DROP COLUMN IF EXISTS ack_key;
 *
 * Do not paste this file into production. Write a new forward-only
 * migration that does the minimum subset of work actually needed.
 */
SELECT 'rollback for 0018 is documentation only' AS note;
