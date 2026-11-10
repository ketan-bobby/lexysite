BEGIN;
CREATE TABLE IF NOT EXISTS pilot_codes (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  max_redemptions integer NOT NULL CHECK (max_redemptions BETWEEN 1 AND 10000),
  redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  disabled boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenant_pilot_grants (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_id text NOT NULL REFERENCES pilot_codes(id),
  previous_plans jsonb NOT NULL,
  redeemed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_pilot_grants_active_uq
  ON tenant_pilot_grants(tenant_id) WHERE ended_at IS NULL;
-- Control-plane only. No direct application-role access to coupon or grant data.
ALTER TABLE pilot_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pilot_grants ENABLE ROW LEVEL SECURITY;
COMMIT;
