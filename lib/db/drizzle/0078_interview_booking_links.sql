-- Reviewed additive rollout; never run at application startup.
CREATE TABLE IF NOT EXISTS interview_booking_links (
  schedule_id text PRIMARY KEY REFERENCES interview_schedules(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  application_id text NOT NULL,
  proposal_version text NOT NULL,
  offer_version text,
  version text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  selected_at timestamptz,
  confirmed_version text
);
ALTER TABLE interview_booking_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_booking_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE interview_booking_links FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON interview_booking_links
  FOR EACH ROW EXECUTE FUNCTION lexy_erasure_write_barrier('candidate_id');

-- Invalidate grants on every relevant proposal change, including change/back
-- cycles; content hashes alone cannot establish chronological revocation.
CREATE OR REPLACE FUNCTION public.lexy_invalidate_interview_booking_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'interview_schedules' THEN
    IF ROW(OLD.application_id,OLD.tenant_id,OLD.scheduled_at,OLD.duration_minutes,OLD.type,OLD.status)
       IS DISTINCT FROM
       ROW(NEW.application_id,NEW.tenant_id,NEW.scheduled_at,NEW.duration_minutes,NEW.type,NEW.status) THEN
      DELETE FROM public.interview_booking_links b WHERE b.schedule_id=OLD.id
        AND NOT (
          b.used_at IS NOT NULL AND b.selected_at=NEW.scheduled_at
          AND OLD.status='pending' AND NEW.status='confirmed'
          AND OLD.application_id=NEW.application_id AND OLD.tenant_id=NEW.tenant_id
          AND OLD.duration_minutes=NEW.duration_minutes AND OLD.type=NEW.type
        );
    END IF;
  ELSIF TG_TABLE_NAME = 'applications' THEN
    IF ROW(OLD.candidate_id,OLD.job_id,OLD.tenant_id) IS DISTINCT FROM
       ROW(NEW.candidate_id,NEW.job_id,NEW.tenant_id) THEN
      DELETE FROM public.interview_booking_links WHERE application_id=OLD.id;
    END IF;
  ELSE
    DELETE FROM public.interview_booking_links
      WHERE schedule_id=COALESCE(NEW.schedule_id,OLD.schedule_id) AND used_at IS NULL;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.lexy_invalidate_interview_booking_link() FROM PUBLIC, lexy_app;
CREATE OR REPLACE TRIGGER lexy_booking_schedule_invalidation
  AFTER UPDATE ON interview_schedules FOR EACH ROW
  EXECUTE FUNCTION public.lexy_invalidate_interview_booking_link();
CREATE OR REPLACE TRIGGER lexy_booking_application_invalidation
  AFTER UPDATE ON applications FOR EACH ROW
  EXECUTE FUNCTION public.lexy_invalidate_interview_booking_link();
CREATE OR REPLACE TRIGGER lexy_booking_offer_invalidation
  AFTER INSERT OR UPDATE OR DELETE ON interview_offered_times FOR EACH ROW
  EXECUTE FUNCTION public.lexy_invalidate_interview_booking_link();
