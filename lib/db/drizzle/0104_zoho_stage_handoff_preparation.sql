BEGIN;
-- Preparatory mappings and simulation receipts only. No live activation flag.
CREATE TABLE zoho_stage_mappings (
  campaign_id text PRIMARY KEY REFERENCES zoho_interview_campaigns(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  revision text NOT NULL,
  advance text, hold text, decline text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (advance IS NULL OR length(btrim(advance)) BETWEEN 1 AND 100),
  CHECK (hold IS NULL OR length(btrim(hold)) BETWEEN 1 AND 100),
  CHECK (decline IS NULL OR length(btrim(decline)) BETWEEN 1 AND 100)
);
CREATE TABLE zoho_stage_handoff_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  campaign_id text NOT NULL,
  recipient_id text NOT NULL REFERENCES zoho_campaign_recipients(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  review_revision text NOT NULL,
  mapping_revision text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('advance','hold','decline')),
  target_status text NOT NULL CHECK(length(btrim(target_status)) BETWEEN 1 AND 100),
  state text NOT NULL CHECK(state = 'simulated'),
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,request_id),
  UNIQUE(tenant_id,recipient_id,review_revision,mapping_revision)
);
CREATE INDEX zoho_stage_handoff_history ON zoho_stage_handoff_events(tenant_id,recipient_id,created_at,id);
ALTER TABLE zoho_stage_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_stage_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE zoho_stage_handoff_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_stage_handoff_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON zoho_stage_mappings,zoho_stage_handoff_events FROM PUBLIC,lexy_app;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON zoho_stage_handoff_events
  FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('candidate_id');
CREATE TRIGGER zoho_stage_handoff_immutable BEFORE UPDATE ON zoho_stage_handoff_events
  FOR EACH ROW EXECUTE FUNCTION public.zoho_campaign_review_immutable();
COMMIT;
