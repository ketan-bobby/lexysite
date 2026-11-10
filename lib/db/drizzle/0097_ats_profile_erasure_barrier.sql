-- Profile provenance is candidate-linked data, including late import results.
-- Keep the existing server-private grants/RLS and shared erasure rules intact.
BEGIN;
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
  BEFORE INSERT OR UPDATE ON public.ats_candidate_profiles
  FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('candidate_id');
COMMIT;
