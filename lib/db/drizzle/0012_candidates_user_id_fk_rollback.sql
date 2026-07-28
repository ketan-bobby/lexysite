-- Rollback for 0012_candidates_user_id_fk.sql
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_user_id_fkey;
DROP INDEX IF EXISTS candidates_user_id_idx;
DROP INDEX IF EXISTS candidates_user_id_unique;
ALTER TABLE candidates DROP COLUMN IF EXISTS user_id;
