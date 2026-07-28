-- ============================================================================
-- 0011 — Candidate work-auth screening + voluntary self-ID demographics
-- ============================================================================
--
-- Two related-but-strictly-separated additions to support EEO/GDPR-compliant
-- candidate data collection:
--
-- 1) candidates.work_authorized / requires_sponsorship / sponsorship_country /
--    sponsorship_notes / screening_completed_at — screening data the
--    candidate self-reports during portal onboarding. Recruiters SEE this on
--    the candidate card. These are job-relevant filters, not protected
--    demographics. All nullable: null = "candidate hasn't answered yet".
--
-- 2) candidate_demographics — entirely separate table for voluntary
--    self-identification (gender, race/ethnicity, veteran, disability).
--    Joined to candidates only by candidate_id (UNIQUE, cascade delete).
--    NEVER joined into the recruiter-facing candidate query. Surfaced only
--    via the aggregate /analytics/diversity endpoint with k-anonymity >= 5.
--    consent_version + consented_at + region let us prove which disclosure
--    copy (OFCCP for US, GDPR Article 9 for EU) the candidate consented
--    under. Every column is nullable because every option includes
--    "prefer not to say" (NULL).
-- ============================================================================

-- (1) Screening columns on candidates
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS work_authorized          boolean,
  ADD COLUMN IF NOT EXISTS requires_sponsorship     boolean,
  ADD COLUMN IF NOT EXISTS sponsorship_country      text,
  ADD COLUMN IF NOT EXISTS sponsorship_notes        text,
  ADD COLUMN IF NOT EXISTS screening_completed_at   timestamp;

-- (2) Voluntary self-ID demographics — SEPARATE table by design.
CREATE TABLE IF NOT EXISTS candidate_demographics (
  id                    text PRIMARY KEY,
  candidate_id          text NOT NULL,
  region                text NOT NULL,
  gender                text,
  gender_self_describe  text,
  race_ethnicity        text[],
  veteran_status        text,
  disability_status     text,
  consent_version       text NOT NULL,
  consented_at          timestamp NOT NULL DEFAULT now(),
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_demographics_candidate_uq
  ON candidate_demographics (candidate_id);
