-- 0052_demo_requests.sql
-- Lead-capture table for the public "Request a demo" / sales-lead form
-- (POST /api/public/sales-lead and legacy /api/public/demo-request).
-- The route has written to this table since launch, but the table was never
-- created in any migration — every submission 500'd. No tenant column: rows
-- are pre-signup prospects with no tenant; the endpoint is public and the
-- table is read only by platform staff tooling.

CREATE TABLE IF NOT EXISTS demo_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL,
  email       text NOT NULL,
  phone       text,
  company     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS demo_requests_created_at_idx ON demo_requests (created_at DESC);
