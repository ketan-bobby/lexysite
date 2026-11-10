-- Additive privacy barrier. Do not use drizzle push: preserve existing RLS.
BEGIN;
CREATE TABLE IF NOT EXISTS public.candidate_erasure_tombstones (
  subject_id text PRIMARY KEY,
  erased_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.candidate_erasure_tombstones FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.lexy_assert_candidate_active(subject text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE erased timestamp;
BEGIN
  IF subject IS NULL OR subject = '' THEN RETURN; END IF;
  -- SHARE conflicts with erasure's UPDATE lock; inspect the tombstone AFTER
  -- waiting, so hard deletion cannot disappear between check and persistence.
  SELECT data_erased_at INTO erased FROM public.candidates WHERE id=subject FOR SHARE;
  IF erased IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.candidate_erasure_tombstones WHERE subject_id=subject
  ) THEN
    RAISE EXCEPTION 'candidate_erased' USING ERRCODE='P0001';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.lexy_erasure_job_blocked(payload jsonb, session_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE subject text; session_ref text;
BEGIN
  subject := NULLIF(payload->>'candidateId','');
  session_ref := COALESCE(NULLIF(session_id,''), NULLIF(payload->>'sessionId',''));
  IF session_ref IS NOT NULL THEN
    SELECT candidate_id INTO subject FROM public.interview_sessions WHERE id=session_ref;
    IF NOT FOUND THEN RETURN true; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.candidate_erasure_tombstones
     WHERE subject_id IN (subject, NULLIF(payload->>'candidateId',''))) THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM public.candidates
    WHERE id IN (subject, NULLIF(payload->>'candidateId','')) AND data_erased_at IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION public.lexy_erasure_write_barrier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE subject text; parent_ref text; prior jsonb; current_row jsonb; affected bigint;
BEGIN
  current_row := to_jsonb(NEW);
  IF TG_OP='UPDATE' THEN prior:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='candidates' THEN
    -- Authorised erasure's first anonymising UPDATE is permitted. No later
    -- update may clear its marker or rehydrate its fields.
    IF TG_OP='UPDATE' AND OLD.data_erased_at IS NULL AND NEW.data_erased_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    -- Account closure may unlink an already-erased historical profile.
    IF TG_OP='UPDATE' AND NEW.user_id IS NULL AND
       (current_row-'user_id'-'updated_at')=(prior-'user_id'-'updated_at') THEN RETURN NEW; END IF;
    PERFORM public.lexy_assert_candidate_active(NEW.id);
  ELSIF TG_TABLE_NAME='ai_jobs' THEN
    -- A terminal privacy discard retains IDs only, never the old result.
    IF NEW.status='failed' AND NEW.last_error='candidate_erased' AND NEW.result IS NULL
      AND (NEW.payload - 'candidateId')='{}'::jsonb THEN RETURN NEW; END IF;
    IF public.lexy_erasure_job_blocked(NEW.payload,NEW.interview_session_id) THEN
      RAISE EXCEPTION 'candidate_erased' USING ERRCODE='P0001';
    END IF;
    subject:=NULLIF(NEW.payload->>'candidateId','');
    PERFORM public.lexy_assert_candidate_active(subject);
    parent_ref:=COALESCE(NEW.interview_session_id,NULLIF(NEW.payload->>'sessionId',''));
    IF parent_ref IS NOT NULL THEN
      SELECT candidate_id INTO subject FROM public.interview_sessions WHERE id=parent_ref FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'candidate_erased' USING ERRCODE='P0001'; END IF;
      PERFORM public.lexy_assert_candidate_active(subject);
    END IF;
  ELSE
    IF TG_TABLE_NAME='sourced_candidates' THEN
      PERFORM public.lexy_assert_candidate_active(NEW.id);
    END IF;
    subject:=current_row->>TG_ARGV[0];
    IF TG_NARGS>1 THEN
      parent_ref:=subject;
      IF parent_ref IS NULL THEN RETURN NEW; END IF;
      EXECUTE format('SELECT candidate_id FROM public.%I WHERE id=$1 FOR SHARE', TG_ARGV[1])
        INTO subject USING parent_ref;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected=0 THEN RAISE EXCEPTION 'candidate_erased' USING ERRCODE='P0001'; END IF;
    END IF;
    -- Retained applications can record the narrowly scoped withdrawal audit,
    -- but cannot receive new scores, notes, assessments or restored stages.
    IF TG_TABLE_NAME='applications' AND TG_OP='UPDATE'
      AND current_row->>'final_decision'='candidate_withdrawn'
      AND (current_row->>'stage'=prior->>'stage' OR current_row->>'stage' IN ('rejected','withdrawn'))
      AND (current_row - ARRAY['final_decision','final_decision_by','final_decision_at',
        'final_decision_attestation','stage','updated_at'])
       = (prior - ARRAY['final_decision','final_decision_by','final_decision_at',
        'final_decision_attestation','stage','updated_at']) THEN RETURN NEW; END IF;
    PERFORM public.lexy_assert_candidate_active(subject);
    IF TG_OP='UPDATE' AND TG_NARGS=1 THEN
      PERFORM public.lexy_assert_candidate_active(prior->>TG_ARGV[0]);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Protect historical soft erasures without touching live profiles.
INSERT INTO public.candidate_erasure_tombstones(subject_id,erased_at)
SELECT id,data_erased_at FROM public.candidates WHERE data_erased_at IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO public.candidate_erasure_tombstones(subject_id)
SELECT DISTINCT candidate_id FROM public.deletion_requests
WHERE storage_cleanup IS NOT NULL AND status IN ('in_progress','fulfilled')
ON CONFLICT DO NOTHING;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='candidate_id'
      AND table_name NOT IN ('deletion_requests','decision_events','fee_line_items')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lexy_erasure_write_barrier ON public.%I', t.table_name);
    EXECUTE format('CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier(''candidate_id'')',t.table_name);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS lexy_erasure_write_barrier ON public.candidates;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON public.candidates
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier();
DROP TRIGGER IF EXISTS lexy_erasure_write_barrier ON public.sourced_candidates;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON public.sourced_candidates
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('normalized_candidate_id');
DROP TRIGGER IF EXISTS lexy_erasure_write_barrier ON public.ai_jobs;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON public.ai_jobs
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier();
DROP TRIGGER IF EXISTS lexy_erasure_write_barrier ON public.interview_summaries;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON public.interview_summaries
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('interview_session_id','interview_sessions');
DROP TRIGGER IF EXISTS lexy_erasure_write_barrier ON public.interview_schedules;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON public.interview_schedules
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('application_id','applications');
-- Workflow event parents have the same candidate_id shape.
DROP TRIGGER IF EXISTS lexy_erasure_write_barrier ON public.recruiting_workflow_events;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON public.recruiting_workflow_events
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('workflow_id','recruiting_workflows');
COMMIT;
