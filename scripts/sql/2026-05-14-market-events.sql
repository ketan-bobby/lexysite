-- 2026-05-14-market-events.sql
-- Wires up identified-company recruiter views, target-company alerts, and
-- event-driven "your market value moved" emails.
--
-- Idempotent.

-- 1. Track WHICH recruiter (tenant) viewed each candidate, so the portal can
--    surface "Someone at Stripe just viewed your profile" instead of an
--    anonymous count, and so we can fire target-company alerts.
ALTER TABLE candidate_action_events
  ADD COLUMN IF NOT EXISTS viewer_tenant_id TEXT;

-- Powers two hot reads:
--   a) "Top viewer companies, last 30d" on the portal pulse card
--   b) "Did target company X view me recently?" target-company match check
CREATE INDEX IF NOT EXISTS idx_action_events_viewer
  ON candidate_action_events (candidate_id, viewer_tenant_id, created_at DESC)
  WHERE event_type = 'recruiter_view' AND viewer_tenant_id IS NOT NULL;

-- 2. Throttle table — guarantees we never spam the same candidate with the
--    same market-event email twice within a cooldown window. Each (candidate,
--    eventKey) row is updated on every send.
--
-- eventKey examples:
--   'target_company_view:tenantId123'
--   'recruiter_view_burst'
--   'peer_band_promotion'
CREATE TABLE IF NOT EXISTS candidate_market_events_sent (
  candidate_id  TEXT NOT NULL,
  event_key     TEXT NOT NULL,
  sent_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (candidate_id, event_key)
);
