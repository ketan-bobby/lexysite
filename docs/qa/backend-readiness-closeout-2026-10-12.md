# Backend engineering closeout — 2026-10-12

## Current compiler status

The backend-wide TypeScript check passed before this work and again after the
route changes. Historical notes describing a remaining compiler backlog do not
describe the current source. No compiler settings, dependencies, casts or
business rules were changed to obtain that result.

The normal API build now runs the existing strict typecheck before its security
guards and bundling. Future compiler failures will stop ordinary builds as well
as the assisted regression gate; no new dependency or compiler relaxation was
introduced.

## Access-control corrections

The production build exposed six known route-ownership exemptions in the
legacy agent pipeline controls:

- GET/POST job pipeline configuration
- GET/POST job interview direction
- GET job pipeline status
- POST job pipeline stop

Each now resolves an existing staff account, applies its current tenant/data
scope and recruiter requisition ownership before reading or changing pipeline
state. Platform-wide `null` scope is preserved; an empty scope grants nothing.
Missing and inaccessible jobs return the same 404 body. Hiring managers keep
read access but cannot configure or stop pipelines through these writer routes.

The corresponding six gap exemptions were removed. A seventh stale exemption
for learning source quality was removed because that endpoint already uses
`requireRole(..., STAFF_ROLES)`. The route checker now requires real access
markers for these handlers instead of overlooking them.

This is access-control hardening, not a commercial restriction on external
sourcing or complimentary Enterprise access. The authorised controls still
work. No interview model, prompt, rubric, provider routing or stored historic
Linx work order was changed.

## Verification evidence

- 31 new real HTTP/database checks passed, using uniquely prefixed disposable
  tenants, users, jobs and pipeline rows. Denied reads/writes left stored state
  unchanged. Authorised configuration, direction and stop operations persisted.
  Tests used `autoRun: false`; they did not run agents or contact providers.
  Fixture cleanup completed.
- The initial combined gate passed its planner/egress checks and fourteen
  non-journey API batches: 554 tests. The outer shell command then timed out
  during the first journey batch. That is not a passing complete gate.
- The remaining journey batches were run separately, without repeating the
  completed batches: 27, 20 and 18 checks, all passed.
- Together with the new route checks, 650 API checks were verified across the
  partial and resumed runs. This is not a claim that the combined command
  returned success in one uninterrupted execution.
- All 128 frontend logic checks in the current baseline manifest passed.
- Repository-wide ESLint returned zero errors. Scoped formatting checks and
  the repository formatting comparison found no new remaining formatting debt.
- The offer browser suite's 36 scenarios were verified earlier against the
  unchanged frontend; they were not needlessly rerun for these backend routes.

## Limits and deferred acceptance

The post-change production build passed its strict typecheck, all twelve
existing guards and bundling, and the managed API restarted successfully.
Unauthenticated requests through the actual development proxy to configuration,
direction and status returned 401. The public sign-in page rendered; its
anonymous protected-resource requests returned expected 401/403 responses.

The existing dormant-Stripe sentinel still logs its configuration warning and
sent its normal platform-admin startup notification. No billing flag or secret
was changed. That warning is not an API startup failure.

A passing build does not certify every allowlisted read path: the
Class-B read guard still carries reviewed exemptions and historical review
tripwires that warrant targeted follow-up, not blanket removal.

AWS résumé-tagging permissions and live SNS delivery callbacks remain deferred
until setup is ready. Multilingual human/audio acceptance and genuine identity
corroboration still require the Linx team. Employer-authorised Greenhouse
connection remains separate. These checks neither send nor accept a real offer,
create employment/fee records, nor activate billing.
