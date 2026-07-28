-- 0047_discovery_consent.sql
--
-- Platform-pool discovery opt-in consent (ruling July 2026: portal access and
-- platform-pool discovery are decoupled; pool='platform' entry requires an
-- explicit candidate opt-in captured here). Append-only audit record, mirrors
-- candidate_ai_consent. previous_pool is restored on withdrawal.

CREATE TABLE IF NOT EXISTS candidate_discovery_consent (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  consent_version text NOT NULL,
  disclosure_snapshot jsonb NOT NULL,
  previous_pool text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  capture_context jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_discovery_consent_candidate_idx
  ON candidate_discovery_consent (candidate_id, consented_at);
