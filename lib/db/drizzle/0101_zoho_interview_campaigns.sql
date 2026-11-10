BEGIN;
CREATE TABLE zoho_interview_campaigns (
  id text PRIMARY KEY, tenant_id text NOT NULL, account_ref text NOT NULL,
  revision text NOT NULL, job_id text NOT NULL, external_job_id text NOT NULL,
  plan_id text NOT NULL, frozen_plan_id text, request_id text NOT NULL,
  snapshot_hash text NOT NULL, brief_hash text NOT NULL,
  application_count integer NOT NULL CHECK (application_count >= 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','cancelled')),
  created_by text NOT NULL, approved_by text, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,request_id)
);
CREATE TABLE zoho_campaign_recipients (
  id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES zoho_interview_campaigns(id) ON DELETE CASCADE,
  tenant_id text NOT NULL, account_ref text NOT NULL, external_job_id text NOT NULL,
  external_application_id text NOT NULL, external_candidate_id text NOT NULL,
  candidate_id text, session_id text, state text NOT NULL DEFAULT 'draft',
  reason text, message_id text, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state IN ('draft','queued','preparing','sending','sent','blocked','review_required','simulated','skipped','cancelled')),
  UNIQUE(campaign_id,external_candidate_id)
);
-- One durable invitation claim per external person and requisition, across campaigns.
CREATE UNIQUE INDEX zoho_campaign_invitation_identity ON zoho_campaign_recipients
  (tenant_id,account_ref,external_job_id,external_candidate_id)
  WHERE state IN ('queued','preparing','sending','sent','blocked','review_required','simulated');
CREATE INDEX zoho_campaign_queue ON zoho_campaign_recipients(state,updated_at);
ALTER TABLE zoho_interview_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_interview_campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE zoho_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_campaign_recipients FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE zoho_interview_campaigns,zoho_campaign_recipients FROM PUBLIC,lexy_app;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON zoho_campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('candidate_id');
CREATE FUNCTION zoho_campaign_identity_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.candidate_erasure_tombstones
    WHERE subject_id='ats-profile:' || md5(jsonb_build_array(
      NEW.tenant_id,'zoho_recruit'::text,NEW.account_ref,NEW.external_candidate_id)::text))
  THEN RAISE EXCEPTION 'Erased ATS identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zoho_campaign_identity_barrier BEFORE INSERT OR UPDATE ON zoho_campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION zoho_campaign_identity_barrier();
CREATE FUNCTION zoho_campaign_frozen_plan_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.zoho_interview_campaigns WHERE frozen_plan_id=OLD.id)
  THEN RAISE EXCEPTION 'Campaign plan is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zoho_campaign_frozen_plan_barrier BEFORE UPDATE OR DELETE ON interview_plans
  FOR EACH ROW EXECUTE FUNCTION zoho_campaign_frozen_plan_barrier();
REVOKE ALL ON FUNCTION zoho_campaign_identity_barrier(),zoho_campaign_frozen_plan_barrier() FROM PUBLIC;
COMMIT;
