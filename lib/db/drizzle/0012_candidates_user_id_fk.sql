-- 0012_candidates_user_id_fk.sql
--
-- Adds candidates.user_id as the canonical link from a candidate row to the
-- portal user that owns it. Replaces the previous email-join lookup in
-- getCandidateId() which let a recruiter (or any non-candidate role) whose
-- email matched a candidate's email read/write that candidate's PII.
--
-- Safety on backfill:
--   * Only link users whose role is 'candidate' (never recruiters / admins).
--   * Tenant-aware: only link within the same tenant_id so a multi-tenant
--     email collision (same email in tenant A's candidates and tenant B's
--     users) cannot bind across tenants.
--   * Skip any (user_id) value that would map to more than one candidate
--     row — those need manual reconciliation before they can be linked.
--   * After link: add a real FK to users(id) with ON DELETE SET NULL so a
--     deleted user nulls out the link rather than orphaning candidate rows
--     to a dangling id.

BEGIN;

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS user_id text;

-- Single-link backfill: for each candidate-role user that has exactly one
-- candidate row in the same tenant matching their email, link the pair.
-- We use a CTE that filters out any user_id with >1 candidate match so
-- we never silently mis-link in an ambiguous case (operator must resolve
-- those by hand). Tenant scoping prevents cross-tenant binding.
WITH eligible AS (
  SELECT u.id AS user_id, c.id AS candidate_id
  FROM   users u
  JOIN   candidates c
    ON   lower(c.email) = lower(u.email)
   AND   c.tenant_id    = u.tenant_id
  WHERE  u.role = 'candidate'
),
unique_user_links AS (
  SELECT user_id, MIN(candidate_id) AS candidate_id, COUNT(*) AS n
  FROM   eligible
  GROUP  BY user_id
  HAVING COUNT(*) = 1
),
unique_candidate_links AS (
  -- Also guard the reverse direction: never bind a candidate row to more
  -- than one user (would violate the unique partial index below).
  SELECT candidate_id, MIN(user_id) AS user_id, COUNT(*) AS n
  FROM   eligible
  GROUP  BY candidate_id
  HAVING COUNT(*) = 1
)
UPDATE candidates c
SET    user_id = uul.user_id
FROM   unique_user_links uul
JOIN   unique_candidate_links ucl ON ucl.user_id = uul.user_id AND ucl.candidate_id = uul.candidate_id
WHERE  c.id = uul.candidate_id
  AND  c.user_id IS NULL;

-- Enforce one-candidate-per-user.
CREATE UNIQUE INDEX IF NOT EXISTS candidates_user_id_unique
  ON candidates(user_id)
  WHERE user_id IS NOT NULL;

-- Helpful lookup index for the hot-path getCandidateId query (partial unique
-- already covers it for non-null lookups, but explicit btree is cheap).
CREATE INDEX IF NOT EXISTS candidates_user_id_idx
  ON candidates(user_id);

-- Real FK so candidates.user_id cannot drift to a non-existent user. We do
-- NOT cascade delete a candidate when their user is deleted — candidate rows
-- can carry interview transcripts and application history we want to keep
-- (subject to GDPR erasure, which is handled separately). SET NULL means
-- the candidate becomes "orphaned of portal access" but their recruiter-
-- side data remains intact.
ALTER TABLE candidates
  DROP CONSTRAINT IF EXISTS candidates_user_id_fkey;
ALTER TABLE candidates
  ADD  CONSTRAINT candidates_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
