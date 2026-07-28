-- Migration 0046: Generic STAGE_CHANGED candidate event (ticket 4d)
--
-- Adds a generic stage-transition event type so EVERY pipeline move — including
-- non-milestone stages (screening/verification/assessment) and backward moves —
-- can be recorded in candidate_events, not just the 8 semantic milestones the
-- old stageToEvent map covered. lib/change-candidate-stage.ts writes this event
-- and a thin-pointer audit_logs row in lockstep, inside one transaction.

ALTER TYPE candidate_event_type ADD VALUE IF NOT EXISTS 'STAGE_CHANGED';
