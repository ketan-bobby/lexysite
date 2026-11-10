# Controlled native screening — 2026-10-09

## Live check

Used a new isolated synthetic tenant, active staff reviewer, approved autonomous
job/journey and fictional SQL backend profile with canonical skills plus a
manually prepared ICP. Background pipeline execution and platform recommendations
were off for this fixture only. No old Linx records were changed.

The real HTTP pilot-activation and execution boundaries returned success.
The existing native screening assessor returned 85/100, recommendation `advance`.
After a new workflow-state read, its job-specific source evidence was saved and
ready for review. All workflow steps remained pending: a model grade is not a
human approval, identity check, contact authorization or hiring decision.

The attributed receipt records one successful request through the existing
OpenAI proxy using the existing gpt-4o model: 587 input tokens and 158 output
tokens. Dollar cost remains explicitly unknown, not zero or a billing estimate.
No résumé parsing, sourcing, identity assessment, outreach or invitation ran.

## Gap found and fixed

The live call initially moved the job-bound source to Screening while its linked
application still said Sourced. Future explicitly workflow-bound screening now
resolves the application through its authorized job and passes both IDs to the
existing atomic stage-change service. Job authorization supports dual-tenant
application rows. Later-stage applications and ambiguous duplicates are not
arbitrarily moved. Ordinary unbound assisted calls remain unchanged.

The isolated fixture's missed application update was repaired through its real
application HTTP endpoint with `skipAutomation:true`, using the already saved
grade. The assessor was not repeated. A second read confirmed score 85 on the
canonical candidate and source, application stage Screening, and unchanged
pending workflow steps. There are two historical stage events for that fixture:
the original source-only transition and the application repair, not two
assessments.

## Verification and limits

- Five focused tests passed: readiness/profile regressions plus isolated
  PostgreSQL stage synchronization, one-event atomicity, foreign-owner/candidate
  rejection, dual-tenant ownership, later-stage protection and duplicate safety.
- The API restarted successfully through its build and security guard sequence.
- Actual native-provider execution happened before the handoff fix. The fix was
  confirmed with isolated production stage-service tests and a no-assessment
  repair, not another paid screening call.
- Résumé ingestion and EnrichLayer live capacity remain separate outstanding
  checks. This is evidence for screening, not completion of all six stages.
- Disposable recruiting records were removed after inspection. Numeric provider
  usage remains as an actual-request cost-attribution receipt.
