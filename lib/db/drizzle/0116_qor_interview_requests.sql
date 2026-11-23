-- Additive, server-private partner tables. Provision credentials separately
-- per database/environment. No plaintext credential or candidate contact data.
CREATE TABLE IF NOT EXISTS public.qor_partner_credentials (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  can_create boolean NOT NULL DEFAULT false,
  can_read boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.qor_interview_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  idempotency_hash text NOT NULL,
  application_hash text NOT NULL,
  payload_hash text NOT NULL,
  external_application_id text,
  external_candidate_id text,
  contact_hash text,
  selection_ref text,
  external_job_id text,
  job_title text,
  job_brief text,
  job_revision text,
  job_approval_ref text,
  job_id text,
  candidate_id text,
  session_id text UNIQUE,
  prepared_by text,
  invitation_released_at timestamptz,
  invitation_released_by text,
  invitation_reported_at timestamptz,
  invitation_reported_by text,
  report_hash text,
  report_version integer NOT NULL DEFAULT 0,
  report_approved_at timestamptz,
  report_approved_by text,
  erased_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS qor_request_idempotency
  ON public.qor_interview_requests(tenant_id, idempotency_hash);
CREATE UNIQUE INDEX IF NOT EXISTS qor_request_application
  ON public.qor_interview_requests(tenant_id, application_hash);
CREATE UNIQUE INDEX IF NOT EXISTS qor_request_candidate_job
  ON public.qor_interview_requests(tenant_id, job_id, candidate_id);
CREATE INDEX IF NOT EXISTS qor_request_erasure
  ON public.qor_interview_requests(tenant_id, contact_hash)
  WHERE erased_at IS NULL;
CREATE INDEX IF NOT EXISTS qor_request_candidate_erasure
  ON public.qor_interview_requests(candidate_id)
  WHERE erased_at IS NULL;
ALTER TABLE public.qor_partner_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qor_partner_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE public.qor_interview_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qor_interview_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.qor_partner_credentials, public.qor_interview_requests FROM PUBLIC;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lexy_app') THEN
    REVOKE ALL ON public.qor_partner_credentials, public.qor_interview_requests FROM lexy_app;
  END IF;
END;
$migration$;
