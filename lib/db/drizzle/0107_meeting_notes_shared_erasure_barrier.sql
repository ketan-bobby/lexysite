-- Preserve the recording-specific candidate lock, and also use the canonical
-- erasure barrier required by the release schema contract. The shared barrier
-- checks both NEW and OLD candidate_id on updates, preventing a late admin-pool
-- write from moving an erased candidate's source material to another candidate.
-- Prerequisite: public.lexy_erasure_write_barrier() from the erasure security DDL.
CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
BEFORE INSERT OR UPDATE ON public.meeting_notes
FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('candidate_id');
