-- Private evidence on the existing one-attempt-per-schedule invitation ledger.
-- Existing forced RLS, grants, erasure barrier and cascade remain unchanged.
ALTER TABLE interview_calendar_invitation_attempts
  ADD COLUMN IF NOT EXISTS panel_snapshot jsonb;
