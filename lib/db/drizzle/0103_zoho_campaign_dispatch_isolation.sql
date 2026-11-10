BEGIN;

-- Internal fixture isolation only. Existing and HTTP-created campaigns stay live.
ALTER TABLE public.zoho_interview_campaigns
  ADD COLUMN dispatch_lane text NOT NULL DEFAULT 'live'
  CONSTRAINT zoho_campaign_dispatch_lane_check
  CHECK (dispatch_lane IN ('live', 'isolated_test'));

COMMIT;
