-- 0048: one ACTIVE (un-revoked) discovery consent row per candidate+version.
-- Race-safety backstop for the grant chokepoint (lib/discovery-consent.ts):
-- concurrent double-POSTs now collapse into a single row via 23505.
CREATE UNIQUE INDEX IF NOT EXISTS candidate_discovery_consent_active_uniq
  ON candidate_discovery_consent (candidate_id, consent_version)
  WHERE revoked_at IS NULL;
