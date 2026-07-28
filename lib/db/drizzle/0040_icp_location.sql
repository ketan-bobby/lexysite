-- 0040_icp_location.sql
-- Add a target LOCATION to the Ideal Candidate Profile.
--
-- Previously the ICP stored every sourcing attribute (skills, titles, domain,
-- boolean string, etc.) EXCEPT location — so the Sourcing agent read location
-- from jobs.location instead of the curated ICP, and the AI scorer never had a
-- target location to judge candidates against. This let out-of-area candidates
-- (e.g. London profiles for a "Telangana, India" search) pass through with no
-- filter or flag.
--
-- Nullable so every legacy ICP row keeps working unchanged; the generator
-- backfills it from jobs.location on the next generation/regeneration.
-- No RLS/policy change — this is a plain column on an already-scoped table.

ALTER TABLE ideal_candidate_profiles
  ADD COLUMN IF NOT EXISTS location text;
