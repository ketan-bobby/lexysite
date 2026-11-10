BEGIN;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
   RAISE EXCEPTION 'ATS ownership policy requires a privileged migration owner with BYPASSRLS';
 END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.ats_stage_is_external(cid text, jid text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
 SELECT EXISTS (
   SELECT 1 FROM public.recruiting_workflows w
   WHERE w.candidate_id=cid AND w.job_id=jid
   AND w.steps @> '[{"key":"hiring_decision","atsStageOwnership":{"status":"external"}}]'::jsonb
 );
$$;
REVOKE ALL ON FUNCTION public.ats_stage_is_external(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ats_stage_is_external(text,text) TO lexy_app;
-- Initial rows bypass the transition choke-point. Never let them invent a
-- second native stage for a candidate/job already controlled by an ATS.
CREATE OR REPLACE FUNCTION public.guard_ats_owned_initial_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE cid text; jid text;
BEGIN
 IF TG_TABLE_NAME = 'applications' THEN
   IF TG_OP='UPDATE' THEN
     IF OLD.candidate_id IS NOT DISTINCT FROM NEW.candidate_id AND OLD.job_id IS NOT DISTINCT FROM NEW.job_id THEN RETURN NEW; END IF;
   END IF;
   cid := NEW.candidate_id; jid := NEW.job_id;
 ELSE
   IF TG_OP='UPDATE' THEN
     IF OLD.normalized_candidate_id IS NOT DISTINCT FROM NEW.normalized_candidate_id
       AND (OLD.raw_data->>'jobId') IS NOT DISTINCT FROM (NEW.raw_data->>'jobId') THEN RETURN NEW; END IF;
   END IF;
   cid := NEW.normalized_candidate_id; jid := NEW.raw_data->>'jobId';
 END IF;
 IF cid IS NULL OR jid IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(jid,cid)::text,78123));
 IF EXISTS (
   SELECT 1 FROM public.recruiting_workflows w
   WHERE w.candidate_id=cid AND w.job_id=jid
   AND w.steps @> '[{"key":"hiring_decision","atsStageOwnership":{"status":"external"}}]'::jsonb
 ) THEN
   RAISE EXCEPTION 'ATS_STAGE_OWNED' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ats_owned_initial_stage() FROM PUBLIC,lexy_app;
DROP TRIGGER IF EXISTS ats_owned_application_insert ON public.applications;
CREATE TRIGGER ats_owned_application_insert BEFORE INSERT OR UPDATE OF candidate_id,job_id ON public.applications
 FOR EACH ROW EXECUTE FUNCTION public.guard_ats_owned_initial_stage();
DROP TRIGGER IF EXISTS ats_owned_sourced_insert ON public.sourced_candidates;
CREATE TRIGGER ats_owned_sourced_insert BEFORE INSERT OR UPDATE OF normalized_candidate_id,raw_data ON public.sourced_candidates
 FOR EACH ROW EXECUTE FUNCTION public.guard_ats_owned_initial_stage();
COMMIT;
