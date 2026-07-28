-- 0033_global_scoring_prior_rollback.sql
-- Reverses 0033_global_scoring_prior.sql.
--
-- Dropping global_scoring_priors reverts every new / thin-data tenant to the
-- static builtin hardcoded prior for hireProbability cold-start (the serving read
-- path treats a missing active row as "use builtin"). Tenants with their own
-- active learned config are unaffected.

DROP INDEX IF EXISTS uniq_global_scoring_prior_active;
DROP TABLE IF EXISTS global_scoring_priors;
