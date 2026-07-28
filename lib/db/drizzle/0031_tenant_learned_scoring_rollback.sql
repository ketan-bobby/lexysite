-- 0031_tenant_learned_scoring_rollback.sql
-- Reverses 0031_tenant_learned_scoring.sql.

DROP INDEX IF EXISTS uniq_tenant_scoring_version;
DROP TABLE IF EXISTS tenant_scoring_weights;
