-- DEVELOPMENT-ONLY rollback for 0058_candidate_introductions_development.sql.
-- Do not use in production without the database/RLS owner's approval.

BEGIN;

DROP TABLE IF EXISTS candidate_introductions;

COMMIT;