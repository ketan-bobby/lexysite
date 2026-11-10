-- Optional, explicitly approved Zoom capture; no public/application table grants.
CREATE TABLE meeting_assistant_workspaces (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  connection_id text NOT NULL, revision text NOT NULL,
  authorized_by text NOT NULL, authorized_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE meeting_attendance (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  schedule_id text NOT NULL REFERENCES interview_schedules(id) ON DELETE CASCADE,
  host_user_id text NOT NULL, connection_id text NOT NULL,
  workspace_revision text NOT NULL, context_hash text NOT NULL,
  consent_statement text NOT NULL, approved_at timestamptz NOT NULL,
  dispatch_token text, state text NOT NULL DEFAULT 'approved',
  bot_id text, provider_state text, event_at timestamptz,
  stop_requested_at timestamptz, media_deleted_at timestamptz,
  imported_note_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state IN ('approved','dispatching','unknown','scheduled','joining','waiting',
    'recording','processing','done','failed','stopping','stopped','deleted'))
);
CREATE UNIQUE INDEX meeting_attendance_appointment_unique ON meeting_attendance(schedule_id) WHERE state <> 'deleted';
CREATE UNIQUE INDEX meeting_attendance_bot_unique ON meeting_attendance(bot_id);
CREATE INDEX meeting_attendance_cleanup ON meeting_attendance(updated_at) WHERE state <> 'deleted';
CREATE TABLE meeting_assistant_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE meeting_assistant_cleanup (attempt_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE meeting_assistant_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_assistant_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_attendance FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_assistant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_assistant_events FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_assistant_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_assistant_cleanup FORCE ROW LEVEL SECURITY;
REVOKE ALL ON meeting_assistant_workspaces, meeting_attendance, meeting_assistant_events, meeting_assistant_cleanup FROM PUBLIC, lexy_app;
-- Serialize approval and late dispatch receipts with the shared candidate-erasure fence.
CREATE TRIGGER meeting_attendance_live_candidate BEFORE INSERT OR UPDATE ON meeting_attendance
FOR EACH ROW EXECUTE FUNCTION lexy_meeting_notes_live_candidate();
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON meeting_attendance
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('candidate_id');
-- Never discard the only provider receipt before provider media is removed.
CREATE FUNCTION lexy_attendance_cleanup_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.dispatch_token IS NOT NULL AND OLD.bot_id IS NULL)
     OR (OLD.bot_id IS NOT NULL AND OLD.media_deleted_at IS NULL) THEN
    RAISE EXCEPTION 'meeting_assistant_cleanup_pending';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER meeting_attendance_cleanup_before_delete BEFORE DELETE ON meeting_attendance
FOR EACH ROW EXECUTE FUNCTION lexy_attendance_cleanup_before_delete();
