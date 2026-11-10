# Assisted release verification — 2026-11-03

## Full run before human-interview notes — all 50 groups passed

A fresh combined run after the offer-session, legacy-smoke and public-offer
freshness changes completed with **50/50 check groups passed, zero failures**.
This is a new execution, not a reinterpretation of the earlier failed report.

Subsequent human-interview recording import adds new code and a development
migration. Its focused verification and limitations are recorded in
[human-interview notes](../engineering/human-interview-notes.md). The 50-group
run below predates that feature and is not claimed to cover it.

- Command: `pnpm test:assisted-baseline`; exit code 0.
- Started: `2026-11-03T12:08:46.308Z`.
- Finished/report update: `2026-11-03T12:25:19.495Z`.
- Machine report: `complete:true`, `status:passed`, `passedChecks:50`,
  `failedChecks:0`, `activeStep:null`.
- API: 1,053 passing tests across 104 files / 29 bounded batches.
- Frontend logic: 265 passing tests.
- Planner/runner/lock guards: 71 tests; outbound-egress guards: five tests.
- Recent database, ATS storage and Zoho handoff catalog audits passed in
  development. This is not external production schema evidence.
- All nine registered browser groups passed, including controlled offers
  (36/36), Zoho campaigns (22/22), panel invitations, Google calendar reads,
  Google invitations, operation recovery, candidate Meet visibility, Google
  panels and staff Google connections.
- Strict frontend/API typechecks and API build/authorization guards passed.
- Lint: zero errors / zero new error fingerprints; warnings are not claimed
  resolved. Formatting: zero differing files.

The report and per-group logs are temporarily retained at
`/tmp/lexy-assisted-baseline-K7SJ2t`. This checked-in summary preserves the
completed outcome after those logs expire. No application source or workflow
configuration needed changing to obtain this result; no failed check was waived.
The older managed workflow's failed card was not rerun merely to repaint it.

This gate does not rerun the separately opt-in native offer-session mutation /
crash-recovery checks, or the six targeted public-offer freshness browser cases;
their earlier focused evidence remains separately documented. No stabilized
models, prompts, commercial settings, credentials or provider scopes changed.
No production or employer provider account was accessed for this run.

See [the consolidated closure list](lexy-release-closure-2026-11-03.md).
The earlier runs below remain historical evidence; their failures and corrections
are not erased by this later success.

## Latest combined run and targeted correction

The subsequent combined development run completed **50 check groups: 49 passed
and one failed**. The failure was the disconnected-employer Zoho browser
scenario: it treated the provider-warning banner as campaign-detail readiness,
then queried a control before its separate detail request had rendered.

Only the browser harness changed. That scenario now deliberately holds the
initial detail GET, verifies that the control is absent while the response is
held, releases the response and waits for the actual campaign control before
asserting that cancellation remains available and contact controls remain
absent. Existing POST-response gates retain their original behavior. There is
no fixed sleep, weakened assertion or application permission change.

The complete affected Zoho browser suite then passed **22/22 scenarios**, with
default-deny network interception, no unexpected requests and no browser
exceptions. The edited harness also passed ESLint, Prettier and Node syntax
checks. The other combined groups completed successfully, including backend
batches, frontend logic, calendar/meeting browser checks, typechecks, builds,
safety guards and the existing lint/format baseline.

The combined runner's raw result remains failed; it has not been rewritten or
represented as a new 50/50 run. The targeted browser rerun supplies subsequent
passing evidence for its one failed group. No other application source changed,
so the unaffected checks were not unnecessarily rerun.

The raw combined report and per-group logs are temporary at
`/tmp/lexy-assisted-baseline-W7ZovQ`. This summary preserves their outcome and
the later browser correction after those files expire. Production, live
provider acceptance and the remaining boundaries below are unchanged.

## Subsequent real audit-storage and erasure checks

After adding transaction-bound insert checks, 15 backend service/HTTP tests
passed. The independently verified development database also passed 12 real
PostgreSQL scenarios (13 TAP tests including the fixture wrapper): actual
minimal audit insertion, SQL failure, exact bindings, active staff, direct and
scoped ATS-identity tombstones, linked-data erasure, unaffected peer data, and
erasure after the final review read. A separate fingerprint-mismatch control
refused DDL. The API and standalone fixture passed strict TypeScript checks.

The SQL fixture used a unique private schema, copied real table constraints
and the relevant cascading foreign key, excluded public from its search path,
and rolled back every row and object. Independent namespace cleanup succeeded.
Canonical review/handoff reads were injected; actual persistence and linked-data
purge implementations ran against PostgreSQL. This does not prove the complete
RLS/trigger environment, public-route/core-account/object-storage erasure,
two-connection concurrency, crash durability or production acceptance.
Minimal legal audit identifiers remain by policy; no retained names, contact
details, transcript, assessment text or exported packet were added.

At this intermediate stage the earlier full consolidated run had not yet been
repeated. See the later combined run and targeted correction above.

## Subsequent audited handoff preparation

The reviewed-handoff download subsequently gained a mandatory local preparation
receipt using the existing audit table, with no migration or Zoho write.
Focused verification passed 13 backend service/HTTP tests, 20 frontend/download
unit tests, all 22 Zoho browser scenarios and generated-client drift checks.
Audit persistence is injected in these focused tests, not a real database
commit/erasure acceptance result. The consolidated execution below predates this
addition; its 49-group result is not represented as a rerun of the new feature.

An automatic consolidated run during implementation finished with 47/49 groups
passing. Its two failures were API typecheck and API build, both reading the
then-in-progress audit-test typings. Those typings were corrected; the current
managed API restart subsequently passed its strict typecheck, all build guards
and bundle build. The focused HTTP suite also passed after correcting the
generated response validator's server-side timestamp representation. The
historical failed workflow card is not represented as a new all-green run.
Both the API and main Lexy preview are running. The real development endpoint
rejects an unauthenticated preparation POST with HTTP 401.

## Subsequent connection-independent review change

After the consolidated execution below, the ATS settings page was changed to
keep saved campaigns and local reviews accessible without a working provider
connection. New snapshots, invitation approvals and remote intake remain gated.
The focused Zoho browser suite passed all 21 scenarios, frontend typecheck and
targeted lint passed, and no backend contract or provider setting changed.
The 49-group result below predates this later UI change and was not rerun for it.
See [the campaign documentation](../zoho-interview-campaigns.md).

## Result

**PASS: 49 of 49 check groups; zero failed groups.**

- Command: `pnpm test:assisted-baseline`.
- Environment: development workspace, not the externally hosted production API.
- Started: 2026-11-03 07:06:14 UTC.
- Completed: 2026-11-03 07:23:59 UTC.
- Final report: `complete: true`, `status: passed`, `failedChecks: 0`.
- API: 1,016 passing tests across 101 files in 28 bounded batches.
- Frontend logic: 228 passing tests, including the reviewed Zoho handoff download.
- Strict frontend/API typechecks and API build/authorization guards: passed.
- Lint: zero total errors and zero new error fingerprints; existing warnings
  are not represented as resolved.
- Formatting: zero failing files.

This supersedes the November 2 consolidated result. The completed run was
already executing when development server recovery began. It was observed
through its progress report rather than duplicated or restarted.

## Browser verification

All nine registered browser groups passed:

- Controlled offers: 36 of 36 scenarios passed.
- Zoho interview campaigns: all 18 scenarios passed.
- Panel invitations.
- Google calendar reads.
- Google invitations.
- Google operation recovery.
- Candidate Google Meet visibility.
- Google interview panels.
- Staff Google calendar connections.

The earlier standalone controlled-offer navigation timeout did not recur in
this consolidated run. No timeout, fixture safety rule, permission gate or
application behavior was changed to obtain the passing result.

## Development server recovery

The failed managed frontend/API starts had collided with older server processes
still holding their assigned ports. The older processes were identified by
listener PID, command and exact artifact working directory before termination.
The existing managed workflows were restarted without changing port assignments
or creating replacement workflows.

The same stale-preview condition was resolved for the public website, both
brochures and the component preview server. All six artifact workflows reported
running afterward. The main frontend and API were confirmed on their assigned
ports, the proxied login returned HTTP 200 and rendered correctly, and
`/api/healthz/live` returned `status: alive`. Liveness is not a database
readiness or authenticated user-journey check.

Historical failed standalone workflow cards may remain visible: the duplicate
baseline invocation exited with conflict code 75, and the earlier standalone
offer-browser invocation timed out. Neither was rerun merely to repaint its
status. The completed consolidated report above is the current validation
evidence.

## Operational warning

API startup reported an existing Stripe-key/dormant-billing mismatch. Checkout
remains disabled without its separate acknowledgment. The existing startup
sentinel recorded an administrative alert email; no billing secret or activation
setting was changed as part of this recovery. This configuration warning is
separate from the passing development suite.

## Remaining boundaries

- No production host or database was accessed or modified.
- No stabilized model, prompt, provider route or commercial plan was changed.
- Zoho reconnection and a dummy-record live campaign remain pending.
- Zoho stage write-back remains simulation-only; no live executor was enabled.
- Linx acceptance, live calendar/meeting account acceptance, external database
  rollout and AWS end-to-end verification remain separate evidence.
- These checks are not a fresh full-project security audit or proof of every
  authenticated UI journey.

The machine-readable final report and per-step logs were retained temporarily
at `/tmp/lexy-assisted-baseline-9K7R0j`. This checked-in summary preserves the
result after those temporary files expire.
