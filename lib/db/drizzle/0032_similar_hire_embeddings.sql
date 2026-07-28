-- 0032_similar_hire_embeddings.sql
-- Task #26 — Real similar-hire embedding signal.
--
-- The similarHirePatternScore signal (the ICP-pattern slice of fitScore) becomes
-- a real embedding-similarity (kNN cosine) comparison of a candidate against a
-- tenant's actual successful hires (outcome ∈ {hired, offer_accepted}) in the
-- same role family. Two tables support it:
--
--  • candidate_embeddings — one profile vector per (tenant, candidate). Profiles
--    are embedded and stored from now on so the comparison corpus accumulates
--    BEFORE the signal turns on. The vector is a JSON number[] (no pgvector
--    dependency) — corpora are small and the cosine math runs in app code.
--    text_hash lets the writer skip re-embedding unchanged profiles.
--
--  • similar_hire_models — per-tenant activation flag. The embedding signal only
--    feeds the live fitScore after the backtest harness confirms it beats the
--    LLM-vs-ICP fallback on that tenant's labeled outcomes. is_active is set true
--    ONLY by a winning backtest; absent/inactive ⇒ permanent LLM-vs-ICP fallback
--    (exactly today's behaviour). At most one row per tenant.

CREATE TABLE IF NOT EXISTS candidate_embeddings (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL,
  candidate_id text NOT NULL,
  model        text NOT NULL,
  dims         integer NOT NULL,
  text_hash    text NOT NULL,
  vector       jsonb NOT NULL,
  profile_text text,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);

-- One stored vector per candidate within a tenant (upsert target).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_candidate_embedding
  ON candidate_embeddings (tenant_id, candidate_id);

CREATE TABLE IF NOT EXISTS similar_hire_models (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  is_active     boolean NOT NULL DEFAULT false,
  min_exemplars integer NOT NULL,
  sample_size   integer NOT NULL DEFAULT 0,
  backtest_json jsonb,
  notes         text,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);

-- At most one activation row per tenant (upsert target).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_similar_hire_tenant
  ON similar_hire_models (tenant_id);
