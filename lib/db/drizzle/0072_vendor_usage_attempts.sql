-- Observation, NOT the spending-authority ledger. App roles cannot read private
-- learning usage or cross-tenant operational data. Admin-pool sink/export only.
BEGIN;
CREATE TABLE IF NOT EXISTS vendor_usage_attempts (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  tenant_id text,
  area text NOT NULL CHECK (area IN ('unattributed', 'interview_unclassified')),
  provider text NOT NULL,
  operation text NOT NULL,
  model text,
  retry_index integer CHECK (retry_index >= 0),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'http_error', 'uncertain')),
  http_status integer,
  latency_ms integer CHECK (latency_ms >= 0),
  units jsonb NOT NULL DEFAULT '{}',
  cost_status text NOT NULL DEFAULT 'unknown' CHECK (cost_status = 'unknown')
);
CREATE INDEX IF NOT EXISTS vendor_usage_attempts_created_idx
  ON vendor_usage_attempts (created_at);
CREATE INDEX IF NOT EXISTS vendor_usage_attempts_tenant_created_idx
  ON vendor_usage_attempts (tenant_id, created_at);
ALTER TABLE vendor_usage_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_usage_attempts FORCE ROW LEVEL SECURITY;
-- No app-role policies intentionally: this is not an employer read surface.
COMMIT;
