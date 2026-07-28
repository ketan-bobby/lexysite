-- 0032_similar_hire_embeddings_rollback.sql
-- Reverses 0032_similar_hire_embeddings.sql.
--
-- Dropping similar_hire_models reverts every tenant to the permanent LLM-vs-ICP
-- fallback for the similarHirePatternScore signal (the read path treats a missing
-- activation row as inactive). Dropping candidate_embeddings discards the stored
-- comparison corpus; profiles are re-embedded best-effort on subsequent runs.

DROP INDEX IF EXISTS uniq_similar_hire_tenant;
DROP TABLE IF EXISTS similar_hire_models;

DROP INDEX IF EXISTS uniq_candidate_embedding;
DROP TABLE IF EXISTS candidate_embeddings;
