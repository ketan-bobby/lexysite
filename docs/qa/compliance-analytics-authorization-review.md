# Compliance analytics authorization review

## Scope and findings

Reviewed the five flagged Class-B reads across diversity, adverse-impact and
AEDT export endpoints. The separate job-create/private career-data scoring
review was not taken over.

An egress-guarded HTTP fixture mounts the real router without tenant RLS,
using uniquely identified disposable development records. Tests reproduced:

- Candidate users could read staff diversity aggregates.
- Erased and DNC candidates still contributed to compliance analytics.
- A locally labelled decision could join a foreign employer's job.
- An AEDT decision could join a foreign application's final stage.
- Diversity returned the exact participation count below its stated k threshold.

## Controls

- Diversity now requires a current staff database role. Raw AEDT exports and
  adverse-impact reports retain their existing platform/tenant-admin gate.
- Diversity applies the canonical erased/DNC/synthetic reporting exclusion
  alongside tenant/data scope and recruiter assignment scope.
- AEDT constrains both decision and job tenants, seals candidate eligibility,
  and tenant-filters the application-stage left join.
- Adverse-impact uses the same authorized application/job and candidate
  eligibility predicates for population coverage and demographic analysis.
  Event reads independently constrain event/job tenant scope and eligibility.
- Below five disclosures, diversity suppresses the precise total as well as
  attribute arrays, retaining the explanatory suppression note.
- Existing four-fifths calculations, population definitions, thresholds,
  candidate/job deduplication, CSV escaping and platform-auditor authority
  remain unchanged.

## Verification

The new nine-test HTTP suite covers permitted own/child employer reads,
foreign employer isolation, inconsistent child rows, anonymous/candidate and
stale privileged-token denial, recruiter reassignment, empty manager scope,
small-group suppression, event isolation, explicit platform-auditor access,
and immediate account-suspension enforcement.

The new suite and four related regression suites passed together:
**55 tests, 55 passed, zero failed, zero skipped.** Related suites cover
four-fifths math, analytics structural invariants, erased/DNC count exclusions
and recruiter-admin data-scope unions.

The two demographics-firewall tests also pass. Its allowlist now names this
development fixture explicitly; no scoring, interview or recruiter-detail
runtime reader was allowed through the firewall.

API typecheck, build and build guards pass, and the API workflow was restarted
successfully. The Class-B guard reports exactly one remaining known exception.
Targeted ESLint reports zero errors (eight existing warnings in analytics).
The public login page still renders; authenticated report authorization is
verified by the HTTP fixtures, not by that public-page screenshot.

The new suite is registered in the assisted release runner. Its earlier
49-group consolidated pass predates these edits; it is not proof of a fresh
full run after this change.

All five analytics review exceptions are now classified with their verified
controls. The job-create career-profile read remains the one separately queued
exception; this review does not claim a complete platform security audit.

Production, schema, LLM configuration and provider settings were not changed.
