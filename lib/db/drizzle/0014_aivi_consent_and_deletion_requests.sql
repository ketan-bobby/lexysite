-- 0014_aivi_consent_and_deletion_requests.sql
--
-- Illinois AIVI Act + general right-to-erasure infrastructure.
--
-- candidate_ai_consent: append-only record proving the candidate saw a
-- specific consent_version + disclosure snapshot and affirmatively
-- consented before any AI-driven interview evaluation began. The
-- /interviews/:id/begin endpoint refuses to mint a session unless an
-- un-revoked row exists for the current version.
--
-- deletion_requests: queue of candidate-submitted erasure requests
-- (AIVI, GDPR Article 17, CCPA). Platform_admin reviews and fulfils via
-- /admin/deletion-requests; fulfilment writes a row to audit_logs.

CREATE TABLE IF NOT EXISTS candidate_ai_consent (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  consent_version text NOT NULL,
  disclosure_snapshot jsonb NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  capture_context jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_ai_consent_candidate_idx
  ON candidate_ai_consent (candidate_id, consented_at);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  candidate_email_snapshot text,
  reason text,
  jurisdiction text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  handled_by_user_id text,
  handled_at timestamptz,
  handler_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deletion_requests_status_idx
  ON deletion_requests (status, created_at);
CREATE INDEX IF NOT EXISTS deletion_requests_candidate_idx
  ON deletion_requests (candidate_id);
