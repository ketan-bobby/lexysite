-- 0031_tenant_learned_scoring.sql
-- Task #25 — Close the loop: outcome-calibrated learned scoring.
--
-- Per-tenant learned hireProbability weights. A learned version only becomes
-- the active config for a tenant after it clears a tunable minimum-sample gate
-- AND beats the live config on that tenant's labeled outcomes via the backtest
-- harness. Exactly one active version per tenant is enforced in application
-- code (deactivate-then-activate transaction). The deterministic hardcoded /
-- live config is the permanent fallback — scoring never depends on a row here.

CREATE TABLE IF NOT EXISTS tenant_scoring_weights (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  version       text NOT NULL,
  config_json   jsonb NOT NULL,
  sample_size   integer NOT NULL,
  is_active     boolean NOT NULL DEFAULT false,
  backtest_json jsonb,
  notes         text,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);

-- A version string is unique within a tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_scoring_version
  ON tenant_scoring_weights (tenant_id, version);

-- At most one ACTIVE learned version per tenant — a DB-level backstop on top of
-- the deactivate-then-activate transaction, so the read path can never see two
-- competing active configs for the same tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_scoring_active
  ON tenant_scoring_weights (tenant_id) WHERE is_active;
