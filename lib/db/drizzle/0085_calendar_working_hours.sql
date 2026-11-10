CREATE TABLE IF NOT EXISTS calendar_working_hours (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  revision text NOT NULL,
  time_zone text,
  windows jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_working_hours_windows_valid CHECK (
    jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) BETWEEN 0 AND 14
    AND (time_zone IS NOT NULL OR windows = '[]'::jsonb)
  )
);
ALTER TABLE calendar_working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_working_hours FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE calendar_working_hours FROM PUBLIC, lexy_app;
