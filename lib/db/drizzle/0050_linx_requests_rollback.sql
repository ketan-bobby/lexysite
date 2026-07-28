-- Rollback for 0050_linx_requests.sql
DROP TRIGGER IF EXISTS linx_requests_freeze_ownership_trg ON linx_requests;
DROP FUNCTION IF EXISTS linx_requests_freeze_ownership();
DROP POLICY IF EXISTS linx_requests_select ON linx_requests;
DROP POLICY IF EXISTS linx_requests_insert ON linx_requests;
DROP POLICY IF EXISTS linx_requests_update ON linx_requests;
DROP POLICY IF EXISTS linx_requests_delete ON linx_requests;
DROP TABLE IF EXISTS linx_requests;
