BEGIN;
CREATE TABLE zoho_campaign_reviews (
  id text PRIMARY KEY, tenant_id text NOT NULL, campaign_id text NOT NULL,
  recipient_id text NOT NULL REFERENCES zoho_campaign_recipients(id) ON DELETE CASCADE,
  candidate_id text NOT NULL, session_id text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('advance','hold','decline')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
  evidence_hash text NOT NULL, previous_review_id text,
  reviewed_by text NOT NULL, request_id text NOT NULL, request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,request_id)
);
CREATE INDEX zoho_campaign_reviews_history ON zoho_campaign_reviews(tenant_id,recipient_id,created_at,id);
CREATE UNIQUE INDEX zoho_campaign_reviews_chain ON zoho_campaign_reviews(recipient_id,previous_review_id) NULLS NOT DISTINCT;
ALTER TABLE zoho_campaign_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_campaign_reviews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE zoho_campaign_reviews FROM PUBLIC,lexy_app;
CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON zoho_campaign_reviews
  FOR EACH ROW EXECUTE FUNCTION public.lexy_erasure_write_barrier('candidate_id');
CREATE FUNCTION zoho_campaign_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Append a new review instead of changing history' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER zoho_campaign_review_immutable BEFORE UPDATE ON zoho_campaign_reviews
  FOR EACH ROW EXECUTE FUNCTION zoho_campaign_review_immutable();
REVOKE ALL ON FUNCTION zoho_campaign_review_immutable() FROM PUBLIC;
COMMIT;
