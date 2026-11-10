-- Private imported human-interview evidence. Application routes enforce job,
-- candidate and current staff authority; no public/app-role table access.
CREATE TABLE meeting_notes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  candidate_id text NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  title text NOT NULL,
  language text NOT NULL,
  consent_at timestamptz NOT NULL,
  consent_statement text NOT NULL,
  planned_questions text NOT NULL DEFAULT '',
  original_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 52428800),
  object_path text NOT NULL,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','processing','completed','failed')),
  processing_token text,
  processing_started_at timestamptz,
  transcript text,
  summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_notes_candidate_job_idx ON meeting_notes(candidate_id,job_id);
ALTER TABLE meeting_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_notes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON meeting_notes FROM PUBLIC,lexy_app;

-- Fence late processing writes during/after candidate erasure, including when
-- an admin-pool worker bypasses RLS. Lock the candidate to serialize with erasure.
CREATE FUNCTION lexy_meeting_notes_live_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM candidates c WHERE c.id=NEW.candidate_id
    AND c.data_erased_at IS NULL FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM candidate_erasure_tombstones t WHERE t.subject_id=NEW.candidate_id) THEN
    RAISE EXCEPTION 'candidate_erased';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_notes_live_candidate BEFORE INSERT OR UPDATE ON meeting_notes
FOR EACH ROW EXECUTE FUNCTION lexy_meeting_notes_live_candidate();
