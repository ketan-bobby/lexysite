ALTER TABLE interview_schedules ADD COLUMN IF NOT EXISTS panel_revision text;
CREATE TABLE IF NOT EXISTS interview_schedule_panels (
  schedule_id text PRIMARY KEY REFERENCES interview_schedules(id) ON DELETE CASCADE,
  revision text NOT NULL,
  coordinator_id text NOT NULL,
  members jsonb NOT NULL,
  buffer_minutes integer NOT NULL CHECK (buffer_minutes BETWEEN 0 AND 60),
  saved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_panel_members_valid CHECK (
    jsonb_typeof(members) = 'array' AND jsonb_array_length(members) BETWEEN 0 AND 5
  )
);
ALTER TABLE interview_schedule_panels ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_schedule_panels FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE interview_schedule_panels FROM PUBLIC, lexy_app;
