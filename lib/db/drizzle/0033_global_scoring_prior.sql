-- 0033_global_scoring_prior.sql
-- Task #27 — Cross-tenant global prior (network effect).
--
-- A platform-global, versioned meta-model for the four hireProbability composite
-- weights {fit,quality,trust,conversion}, learned from ANONYMIZED, AGGREGATED
-- signal→outcome statistics pooled across tenants. Only sufficient-statistic
-- aggregates (sums/counts — never candidate records or tenant identifiers) are
-- pooled to produce these weights, so no candidate-level data crosses a tenant
-- boundary.
--
-- A new / thin-data tenant (no active per-tenant learned config) initializes its
-- scoring prior from the active row here instead of the static builtin weights;
-- as the tenant accrues its own labeled outcomes, per-tenant learning
-- (tenant_scoring_weights) shrinks toward this prior and eventually overrides it.
-- A row is set is_active ONLY by a training run that clears minimum
-- contributing-tenant + total-sample gates AND a federated evaluation. The static
-- builtin remains the permanent fallback — serving never depends on a row here.
-- Managed exclusively through controlDb by platform admins.

CREATE TABLE IF NOT EXISTS global_scoring_priors (
  id                   text PRIMARY KEY,
  version              text NOT NULL UNIQUE,
  label                text NOT NULL,
  prior_json           jsonb NOT NULL,
  sample_size          integer NOT NULL,
  contributing_tenants integer NOT NULL,
  aggregate_json       jsonb,
  is_active            boolean NOT NULL DEFAULT false,
  evaluation_json      jsonb,
  notes                text,
  created_at           timestamp NOT NULL DEFAULT now(),
  updated_at           timestamp NOT NULL DEFAULT now()
);

-- At most one active meta-prior platform-wide (deactivate-then-activate backstop).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_global_scoring_prior_active
  ON global_scoring_priors (is_active) WHERE is_active;
