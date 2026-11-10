# Lexy autonomy: phased rollout and regression gates

## Phase 0 scope

Establish a repeatable assisted-flow baseline before introducing autonomy. This
phase adds tests and validation tooling only. It does not add operating modes,
enable agents, change schemas, send candidate messages or change production.

The Intelligence Engine and internal-first sourcing remain core protections:
candidate scoring/evidence must remain requisition-specific; Internal Mobility
means only the hiring client's current employees; ordinary sourcing means known
nonemployees plus permitted external discovery. Never mix these categories.

## Repeatable gate

Run `pnpm test:assisted-baseline` after each coherent phase.

The command runs:

- A self-test of the test-only outbound HTTP guard.
- Real API/DB regression suites for staff authentication, requisition
  create/PUT/GET, ownership, privacy, employee-only/database sourcing, real-run
  score/link persistence, cross-job cache isolation, atomic stage transitions,
  interview consent, link idempotency, result access and recording ownership.
- Frontend logic tests for work-order approval and Intelligence Engine score,
  trust-gate and nullable-score presentation.
- Frontend typecheck and the API build with its existing structural guards.
- Repository lint and formatting comparisons against explicit pre-existing debt.

Each run stores full logs and a machine-readable summary in a unique temporary
directory printed at completion. All new test fixtures belong to the test and
must be cleaned up; integration suites run sequentially to avoid shared-fixture
collisions. Do not run multiple baseline commands concurrently.

Tests use injected/mock provider/scoring dependencies where needed. Their
preload permits only HTTP servers created inside that test process and rejects
other fetch/HTTP(S) calls before integrations are contacted (including shared
localhost AI proxies)
and fails the test process even if application code catches the rejection.
Existing PostgreSQL/pg fixture access is allowed. This is a guard for these
curated tests, not a general-purpose network sandbox.

## Pre-existing quality debt

Before Phase 0 edits, repository lint had one error in the candidate-detail page:
`no-constant-binary-expression`, plus 490 warnings. Formatting failed in 45 files.
The explicit fingerprints/paths live in `scripts/assisted-quality-baseline.json`.
The incremental gate must reject new errors and newly unformatted files. Never
automatically expand those allowances.

A passing incremental gate does **not** mean repository-wide lint/format is clean.
The API's historical full-TypeScript diagnostics are not silently waived as a
successful typecheck: the current gate uses the API build/structural guards and
frontend typecheck. Full API typecheck cleanup remains separate work.

## Coverage limits

These are focused regression tests, not proof that every application journey is
working. They do not prove live provider quality, calendar integration, real
deliverability, every outreach approval/send path, or a completed graded AI
interview. Human interview coordination is not yet implemented by this work.

Existing browser evidence from the sourcing-mode feature covered checkbox
default/toggle, edit/save/reload and employee-only/normal sourcing views. It is
historical evidence, not a fresh end-to-end test of each future phase.

Use a single targeted browser pass when a later phase materially changes a
critical user journey. Test external services separately with explicitly
authorised sandbox fixtures; never turn on live candidate contact to obtain a
green regression result.

## Phase acceptance criteria

| Phase | Scope | Required proof before enablement |
| --- | --- | --- |
| 0 | Assisted baseline | New tooling/test checks pass; existing failures and coverage gaps remain explicit. |
| 1 | Configuration only | Existing requisitions stay assisted; operating mode/path round-trips; authorised editing only; saving settings causes no execution or spend. |
| 2 | Per-requisition workflow state | Independent candidate/job/step evidence and authority; versioned approved journeys; atomic/idempotent work; pause/cancel; assisted compatibility. |
| 3 | Shadow execution | Explain proposed actions without stage writes, contact, invitations or unapproved provider/model spend. |
| 4 | Autonomous sourcing | Approved scope, deterministic stopping rules, reserved budgets, deduplication, restart recovery and accurate pipeline links; outreach disabled. |
| 5 | Autonomous engagement | Explicit requisition authority, approved claims, contact conflict controls, opt-out races, duplicate-send prevention, reply uncertainty and exception handling. |
| 6 | Interview orchestration | Consent, AI/human separation, scheduling permissions, feedback authority, reminders/reschedules and safe composed paths. |
| 7 | Limited pilot | Selectively enabled requisitions; operational metrics, bounded spending, incidents/exception review and documented stop/rollback procedure. |

## Product and safety boundaries

- Overall mode is a preset, not blanket authority. Each checkpoint has explicit
  progression authority; final hiring decisions remain human-owned.
- Support AI Interview, Human Interview, AI → Human, Human → AI and recruiter
  choice per candidate through reusable, validated journey steps.
- Interview type, coordination mode and progression authority are separate.
- A candidate's identity may be reused; another job's workflow flags must not
  authorise or suppress activity on this job.
- Incomplete/uncertain assessments and technical failures route to recovery or
  review, not an inferred rejection.
- Material brief changes need renewed approval. Existing candidates are not
  silently rerouted or booked meetings silently cancelled.
- Autonomous sourcing, engagement and interview coordination have independent
  enablement and stop controls. Existing assisted operation remains available.
- Changes are additive first. Verify development and production migration
  targets separately; publishing is not assumed to migrate an external database.
- Pause prevents pending/new actions and spend; it cannot undo sent messages.
- Sharing an evaluation/slate is a separately authorised disclosure action.

## Phase 0 execution result

Verified on 2026-10-05:

- 200 tests passed: 5 test-egress safeguards, 167 API/DB regression tests and
  28 frontend logic tests. No failures, cancellations or skips.
- Frontend typecheck and API build/structural guards passed.
- No additional lint errors or formatting failures beyond the recorded baseline.
- Application health endpoint returned HTTP 200 with its DB check healthy.

The first pass exposed unsafe legacy live-SES/S3 test paths, an unassigned
recruiter positive-control fixture, a frontend test-loader resolution problem
and a score-band scanner false positive for a selected-role count limit. These
were corrected in test tooling/fixtures only: SES, model generation and S3 now
use test doubles; the legitimate recruiter is explicitly assigned; the installed
API test loader is reused; and the non-score role-count exemption is narrow.
Production access checks were not relaxed.

No product runtime files or database schemas were changed. No production
migration or publish was performed. Autonomy remains unimplemented/disabled;
Phase 1 is configuration-only and must meet its own acceptance criteria.

## Phase 1: requisition configuration

The create wizard and work-order Overview expose two persisted preferences:

- **Recruiting mode:** Human Assisted (default) or Lexy Autonomous (planned).
- **Planned interview path:** AI, Human, AI then Human, Human then AI, or
  recruiter choice per candidate (default).

These are preferences, not execution switches. The API always reports
`autonomyExecutionEnabled: false` and `progressionAuthority: human_review`.
Existing assisted controls, sourcing scope, interview assessment types and
candidate stages remain unchanged. Human coordination and composed interview
paths are not implemented by this phase.

The dedicated configuration PATCH accepts only those two settings and requires
an authenticated, permitted staff role, tenant/data scope, and recruiter or
hiring-manager assignment where applicable. Ordinary PUT edits cannot overwrite
the preferences. Saving configuration does not use the ordinary edit route's
ICP regeneration. Standard creation retains its existing behaviour, including
ICP generation for sufficiently long descriptions.

The new focused regression suite is included in the repeatable assisted gate.
It covers all ten mode/path combinations, legacy/create defaults, fresh reads,
partial edits, invalid payload atomicity, authorized and unauthorized role and
tenant paths, persistence of audit records, and unchanged stages, queued work,
pipeline runs, messages, interviews and credit usage. Provider execution is
mocked or blocked by the test-only egress guard; this does not sandbox the
separately running application's schedulers.

The additive migration is `lib/db/drizzle/0068_job_recruiting_configuration.sql`.
Its target was verified and it was applied to development only. Existing
development requisitions retained Human Assisted / recruiter-choice defaults.
Production migration and publishing are separate, explicit steps; do not
publish code that selects these columns against an unmigrated database.

### Phase 1 verification result

Verified on 2026-10-05:

- The complete assisted gate passed 227 tests: 5 egress safeguards, 194 API/DB
  tests and 28 frontend logic tests, with no failures or skips.
- An additional focused compatibility test passed for ordinary interviewer
  creation without new configuration authority. Frontend typecheck passed again
  after the corresponding wizard permission correction.
- API build/structural guards passed. The incremental gate found no new lint
  errors or formatting failures; the existing one error and 45 files remain.
- Normal signed-in browser creation persisted planned Autonomous / AI then Human;
  editing to Human Assisted / Human and reloading persisted the new preferences.
  Defaults, all five choices, sourcing mode and existing assisted controls were
  visible. No provider stubs were needed; the 13-character fixture description
  avoided the existing ICP trigger and had no agent runs.
- The browser's misleading generic creation-success claim that ICP was running
  was replaced with neutral copy. The health endpoint returned HTTP 200 with its
  DB check healthy.

This is development verification of configuration and assisted compatibility,
not live autonomous execution, human scheduling, or every integration journey.
The existing application-startup Stripe-key sentinel alert remains outside this
phase; billing configuration was not changed. No production migration or publish
was performed.

## Phase 2: approved journeys and candidate/requisition state

The work-order Overview now contains a separate planned-workflow surface:

- Capture an immutable, numbered journey draft from the current requisition,
  ICP and interview direction. Human approval binds that exact snapshot.
  Permitted administrators and the assigned hiring manager can approve; ordinary
  recruiters can draft and record non-final evidence, not grant approval or
  record final hiring-decision evidence.
- Explicitly enroll an already-linked, currently visible candidate into an
  approved version. Recruiter-choice journeys require a concrete candidate path.
  Every step retains `human_review` authority; approval does not activate workers.
- Record ordered manual evidence, including review-required and failed states.
  Neither uncertain results nor technical failures infer a rejection. This
  evidence is not an AI assessment, an Intelligence Engine signal, or an
  application-stage/hiring-outcome write.
- Pause, resume or cancel an individual planned workflow. Pausing blocks new
  workflow evidence; cancellation retains completed evidence and history.
  These controls do not disable existing assisted tools or recall sent messages.
- Material brief/configuration/ICP/interview-direction changes mark older
  versions stale. Further work requires a current approved version and explicit
  enrollment, never automatic rerouting. Existing versions and evidence remain.

Candidate identity is reusable, but workflow state is scoped to tenant,
requisition, candidate, approved journey version and step. New child-table
queries repeat tenant/job predicates. Candidate options and related history
respect current hard exclusions and platform-pool privacy. The additive tables
have forced tenant RLS; journey snapshots cannot be rewritten after capture.

All mutations serialize per requisition and commit state, audit event and
idempotency receipt in one transaction. Request fingerprints bind the operation,
payload and actor; conflicting key reuse fails. Workflow revisions reject
competing/stale updates. There is no queue dispatcher, agent runner, contact,
invitation, booking, provider call or budget reservation in this phase.

The migration `lib/db/drizzle/0069_recruiting_workflow_state.sql` was applied only
after both the application and development SQL target reported `heliumdb`.
Existing requisitions/applications were not backfilled or advanced.
Production migration and publishing remain separate, explicit steps.

### Phase 2 regression verification

Verified on 2026-10-05:

- The complete assisted gate passed 260 tests: 5 egress safeguards, 227 API/DB
  tests (including 32 new workflow checks), and 28 frontend logic tests.
  No failures or skips.
- New checks cover role/assignment/data-scope gates, all five planned paths,
  immutable/stale approval, explicit candidate linkage, cross-job isolation,
  concurrent idempotent retries, revision conflicts, ordered recovery evidence,
  pause/resume/cancel, final human authority, current DNC history suppression,
  app-role RLS isolation, and no execution/spend/contact/stage effects.
- Frontend typecheck and API build/structural guards passed. A separate API
  TypeScript diagnostic pass found no errors in the new service/routes/tests;
  historical full-API diagnostics remain elsewhere.
- The incremental quality gate found zero new lint errors or unformatted files.
  Existing debt remains one lint error and 45 formatting failures.
- Both managed workflows restarted successfully; the health endpoint returned
  HTTP 200 with a healthy database.
- A normal signed-in browser pass verified draft approval, explicit enrollment,
  review-required evidence and reload, manual completion, pause/resume, confirmed
  cancellation and reload. Completed evidence/history survived cancellation;
  pending steps became cancelled. Its application remained `applied`, with zero
  fixture-scoped queued jobs, agent runs, interviews, outreach or credit usage.
  All fixture records were removed.

The browser did not exercise a follow-on draft after editing Phase 1 preferences;
API tests cover material-change staleness and versioning. A screenshot exposed
horizontal overflow near the sidebar; the new card was given local width/overflow
containment and a wrapping header. That CSS-only correction was statically
checked, not given another signed-in browser pass.

This gate does not verify every integration or autonomous execution. Existing
application schedulers remain unchanged and are not sandboxed by the test-only
egress guard. The pre-existing Stripe sentinel startup alert remains outside
this phase; billing secrets were not changed.

## Phase 3: read-only shadow proposals

Work-order Overview adds **Lexy shadow proposals** inside the planned workflow.
Opening it explains requisition-level internal-first review and each visible
candidate's next unresolved step, with reasons, blockers and still-required
checks. It refreshes while open and after local journey/evidence/control changes.
An explicit refresh is available; errors do not silently show an old preview.

This is a deterministic rules preview, not an LLM simulation, scoring result or
live agent run. Its basis is the current brief, exact approved journey, concrete
candidate path, workflow revision and ordered manual notes. The Intelligence
Engine remains separate; manual completion notes are not real assessment results.
The source scope distinguishes this client's current employees from known
nonemployees followed by permitted external discovery.

The preview:

- Blocks non-live jobs, paused workflows, stale/missing/unapproved bound journeys
  and mismatched versions/paths. It never silently rebinds or reenrolls a candidate.
- Treats failed/review-required evidence, missing completion notes, unsupported
  steps and inconsistent authority/sequence as human review or recovery, not
  rejection or automatic progression.
- Keeps evaluation review and final hiring decisions human-owned. Final-decision
  proposals also identify when the current viewer lacks approver authority.
- Identifies consent, privacy, lawful sources, provider/model selection, budget,
  duplicate-send prevention, calendar permission and human assignment checks as
  still required. It does not claim those external prerequisites are satisfied.
- Reports zero model calls, disabled execution and an unknown future execution
  cost. It does not fabricate a zero-cost quote for later paid work.
- Retains the Phase 2 role/assignment/data-scope and current candidate privacy
  seals through a shared reader. No foreign or currently DNC candidate proposal
  is exposed.

The GET-only API is `/api/jobs/:jobId/workflow-shadow`. It has no execution or
approval mutation route. Reading it does not write workflows, evidence,
idempotency receipts, candidate events, stages, queued work or credit reservations.
Ordinary HTTP access logging and existing schedulers remain unchanged. No database
migration was needed for this phase; production and billing configuration were
not changed.

### Phase 3 regression verification

Verified on 2026-10-05:

- The full assisted gate passed 278 tests: 5 egress safeguards, 245 API/DB tests
  and 28 frontend logic tests. No failures or skips.
- Seventeen pure-rule tests and one additional API/DB test cover proposal order,
  both presets, employee/nonemployee scope, terminal states, stale approval,
  uncertain evidence, unsupported sequence/authority, human final decisions,
  all four concrete interview paths, unchanged business state on repeated reads,
  fresh progress after evidence updates and rejection of a forged POST execution
  request. Existing role and DNC tests also exercise the shadow read.
- Shared-library and frontend typechecks plus the API build/guards passed.
  A separate full API typecheck reported zero diagnostics in changed workflow
  files; historical diagnostics elsewhere remain.
- No new lint errors or formatting failures; the recorded one-error/45-file
  legacy debt remains unchanged. Managed API/frontend workflows were restarted.
- Deep health returned HTTP 200 with a healthy DB. A normal signed-in desktop
  browser pass initially exposed whole-page horizontal overflow under the fixed
  sidebar. The staff shell's flex width constraint was corrected and the
  interrupted flow resumed with a fresh isolated fixture.
- The resumed 1440×1000 pass confirmed the panel fits to the right of the sidebar
  without material document overflow. Draft approval/enrollment updated the open
  preview to Screening automatically; manual completion updated it to
  Verification without navigation or manual refresh. Reload/reopen preserved
  that authoritative proposal.
- Shadow hide/reopen/refresh reads retained the same one journey, one workflow,
  four events and four receipts. The application stayed `applied`, and scoped
  queued AI jobs, agent runs, interviews, outreach and credit usage stayed zero.
  All test fixtures/access logs were cleaned up. The CSS-only width correction
  was verified in this resumed browser flow; the passing API/logic gate was not
  unnecessarily repeated.

These checks prove deterministic preview behavior and focused assisted
compatibility, not real provider quality, deliverability, scheduling, autonomous
budget reservation or execution. Those remain gated to later phases.

## Phase 4A: sourcing control foundation (dispatch still locked)

The product owner selected **USD vendor spend**, not Lexy usage credits. The
work-order Overview now supports saving explicit employee/known-nonemployee
scope, optional external provider allowlists, planned candidate/runtime limits,
per-prepared-run USD caps, a requisition allocation cap and a maximum number of
outstanding prepared holds. Saving revokes earlier approval; a permitted human
approver binds the exact current approved journey, brief and limits.

Prepared runs allocate part of that USD cap transactionally. They are durable
bookkeeping holds, **not** vendor quotes, account funding, card charges, actual
spend or queued provider work. They can be paused, resumed or cancelled; pause
retains allocation and cancellation releases only an unused, never-dispatched
hold. Material brief changes block new holds/resume. Existing holds retain their
original snapshot and are never silently rebound. Concurrent requests serialize
per requisition; identical actor/payload/key retries return one receipt and one
allocation. Different key reuse, stale revisions, foreign holds and cap
oversubscription fail.

The control tables have forced tenant RLS, while route and child reads also
repeat job/tenant scope. Existing workflow event/receipt transactions record
control changes atomically. Internal Mobility forbids external providers. The
existing internal-review behavior remains **advisory** for assisted sourcing;
Phase 3 wording was corrected rather than restoring a legacy blocking marker.
Assisted sourcing, scoring and pipeline linking were not changed.

**Phase 4 is not complete or enabled.** Reliable provider/model prices have not
been verified. There is no dispatch/enable control or worker consuming prepared
holds; execution and outreach are always false. Planned candidate/time limits
are not advertised as runtime enforcement. Prepared-hold persistence is not
proof of recovery from in-flight paid calls.

The next part requires trusted conservative cost bounds before every billable
request (including hidden fan-out/retries and model work), durable operation
identity, cancellation/lease fencing, uncertain-cost retention/reconciliation,
safe paid restart recovery and exact candidate/requisition pipeline links. No
unpriced operation or fabricated fallback assessment may be dispatched.

The additive `0070_sourcing_control_reservations.sql` migration was applied to
development only after both app and SQL target reported `heliumdb`. No production
migration, billing configuration, real provider run or publish was performed.

### Phase 4A verification

Verified on 2026-10-05:

- All eleven new API/DB checks passed: authority/assignment, strict invalid-body
  rejection, employee/provider scope, concurrent USD cap protection, same-key
  deduplication, paused/cancelled allocation, prepared-count/held-USD floors,
  staleness, foreign-hold isolation, forced app-role RLS and no queued/spend effects.
- The full assisted command ran 289 unique tests: 5 egress, 256 API/DB and 28
  frontend logic checks. Its single failure was the old shadow expectation of
  a blocking internal-review marker. That assertion was corrected to the
  existing advisory rule; all 17 shadow tests passed in the focused rerun.
  The full command was not repeated after this test-only correction; its saved
  aggregate exit/result still records that original failure.
- Frontend typecheck, API build/structural guards, incremental lint and format
  passed. Existing debt remains one lint error and 45 formatting failures.
  A separate full API diagnostic attempt timed out and is not claimed as a
  successful typecheck.
- Managed services restarted; deep health returned HTTP 200 with DB healthy.
  The signed-in 1440×1000 pass verified save/approve, prepared holds after reload,
  pause/resume, confirmed cancellation and release, exactly USD 2.00 allocated,
  and an explicit HTTP 409 rejecting a third USD 1.00 hold. No additional event
  or receipt was written for that rejected attempt.
- The panel fits to the right of the fixed sidebar without material horizontal
  overflow. Locked execution, unknown pricing and non-payment bookkeeping copy
  were visible. The application stayed `applied` with zero fixture-scoped queued
  AI jobs, agent runs, interviews, outreach or credit usage.
- Browser fixtures, control rows and access logs were removed and cleanup
  verified. Incidental missing-ICP 404s and unrelated 403s remain outside scope;
  these results are not a claim of globally clean logs or live dispatch safety.

## Phase 4B: metering and interruption-recovery mechanics (live adapters locked)

The control foundation now includes a durable per-operation USD cost ledger and
worker lease fencing. Amounts use integer USD micro-units (one million per USD);
unused allocation release rounds aggregate retained exposure **up** to cents.
Settled cost and uncertain possibly charged cost remain counted after a hold is
cancelled. Preparing another hold cannot reclaim or erase that exposure.

Each operation has a stable request fingerprint, immutable upper bound, price
version/expiry/evidence, unique identity and original attempt token. Preparation
serializes against the same job lock as hold and workflow changes. Unknown,
expired or zero upper-bound pricing fails closed. The per-run cap is checked
before reservation; the current requisition cap, actor/approver authority, job
approval, brief and approved journey/policy snapshot are rechecked before work.
No caller-controlled API field can provide a quote or unlock paid dispatch.

Lease ownership/generation, expiry and an original runtime deadline are durable.
Pause/cancel fences the worker. Recovery increments the generation without
resetting the deadline or candidate-key count. Never-dispatched operations can
be adopted under their original identity and still-current quote; dispatched
crash markers become uncertain and are never automatically resent. New
operations/dispatch stop while the requisition has in-flight or uncertain cost.
The bounded test executor also interrupts an adapter that ignores AbortSignal.

Cancellation voids only prepared, never-dispatched operation reservations.
Matching late receipts can settle their original attempt after pause, cancel or
lease expiry without authorizing more work. Settlement is idempotent and rejects
conflicting evidence. Reported cost above a quote is retained as an unresolved
anomaly, not silently clipped/refunded. Pricing evidence is kept separately from
billing evidence. Forced tenant RLS and composite parent-scope foreign keys
protect the new lease/operation tables.

The Overview shows read-only spent, uncertain and pending totals plus operation
statuses, versions and nullable actual/reported values. It preserves sub-cent
precision and explains cancellation retention. It offers no pricing, dispatch
or reconciliation command.

### Scope and acceptance limits

**This is not completed live autonomous sourcing.** The live cost catalog is
empty and real dispatch remains hard-locked. The only executor added is explicitly
test-only; it refuses to invoke adapters outside NODE_ENV=test. No existing
assisted provider/model call was redirected, restricted or presented as metered.
Provider/model adapters must first be audited down to every billable HTTP/SDK
request, retry and fan-out child. A single estimate around a multi-call search is
not sufficient. Rates must describe the actual account/billing contract, not an
invented public-price fallback.

The cost mechanics do not yet supply a real-provider billing reconciliation
adapter, invoice recovery, persistent paid model outputs or candidate→requisition
orchestration. Runtime and candidate-key limits are exercised in the test kernel,
not claimed as enforcement of the existing live discovery pipeline. Completing
those integrations and fault-injection acceptance is required before any paid
enablement; outreach still requires its own later approval/capability.

The additive `0071_sourcing_metering.sql` migration was applied to development
only after both application and SQL targets again reported `heliumdb`. No live
vendor/model call, production migration, spending activation or publish occurred.

### Verification

- Full assisted gate: **302 tests passed** (5 outbound guard, 269 API/DB, 28 web
  logic), frontend typecheck and API build/structural guards passed. No new lint
  or formatting debt; existing totals remain one lint error and 45 format files.
- The sourcing suite now has 24 checks, including integer/sub-cent retention,
  duplicate identities, unknown/expired quotes, provider scope, concurrent lease
  claims, crash markers, fencing, ignoring-adapter interruption, stopping limits,
  revoked authority, abnormal receipts, foreign scopes and new-table RLS/FKs.
- A separate full API typecheck exposed historical diagnostics plus narrowing
  issues in the new services. The never-returning throw helpers were changed to
  explicit function declarations. That full diagnostic rerun timed out; no clean
  full API typecheck is claimed. Runtime/regression and frontend checks passed.
- Signed-in 1440×1000 verification used isolated, explicitly fixture-only pricing
  and synthetic receipt evidence, with no provider/SDK invocation. After reload,
  the ledger preserved USD 0.200001 settled, USD 0.60 uncertain and zero pending.
  Cancelling the uncertain hold retained USD 1.60 allocated; cancelling both
  retained the combined USD 0.800001 exposure rounded up to USD 0.81, leaving
  USD 1.19 available under a USD 2.00 cap. Both cancelled holds and their cost
  operations remained visible with the unused-allocation-only notice.
- No execution/pricing/reconciliation control was added. Nullable actual cost
  displayed as unknown, not zero; fixed-sidebar geometry remained contained.
  The application stayed applied, and fixture-scoped queues, runs, interviews,
  outreach and credit usage remained empty. Meter/lease/hold and other fixture
  rows were removed in dependency order with all cleanup counts verified zero.
  Optional missing-ICP 404s and ambient permission/session responses were noted
  separately; this is not globally clean logs or genuine live billing proof.

## Assisted-baseline recheck — 2026-10-06

The previously reported sourcing completion failure did not reproduce in either
an isolated, egress-guarded run or the full assisted baseline. The full recheck
passed all 280 API tests, 34 frontend logic tests, five outbound-guard tests,
frontend typecheck, API build/structural guards, and the unchanged lint/format
debt comparisons. Logs: `/tmp/lexy-assisted-baseline-oe1Zpr`.

The completion assertion now includes the run's persisted error reason instead
of only comparing `failed` against `completed`. No expectation, production
recovery behavior, access check or dispatch lock was weakened.

The earlier failure coincided with API startup: startup recovery reported one
interrupted run during that test's execution window. Recovery marks active
in-process runs failed in the same development database that the integration
fixtures use. The historical output did not capture the affected run ID/error,
so this is a plausible interference mechanism, not a conclusively reproduced
root cause. Do not run the shared-database regression gate during API startup or
restart, and do not claim the improved diagnostics fix an underlying runtime bug.

No application restart, paid provider/model call, pricing change or autonomous
activation was performed for this recheck. Cost instrumentation and verified live
adapters remain prerequisites for the next execution phase; a green assisted
baseline does not make autonomous execution available.
