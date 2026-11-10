# ATS connector foundation and Greenhouse verification

## Implemented scope

Lexy retains native hiring and its separate manual ATS handoff/export.
The Greenhouse adapter now has scoped staff routes and UI under each workflow's
ATS handoff. It verifies mapped Harvest v3 records and previews the mapped job's
applications. Explicit selection can now import job/application metadata into a
separate ATS intake view. A separate employer-approved review can import or link
a local candidate profile (see below). Neither action changes stages, writes
evidence to Greenhouse, sends offers, or enables automatic profile synchronization.

### Authorization and account allocation

The configured Replit Harvest integration supplies OAuth and transport.
Greenhouse candidate-ingestion is a different connector and is never selected.
No credential or token entry form exists in Lexy.

Project integration access alone grants no employer access:

1. A platform administrator selects a Harvest project connection and allocates
   it to the work order's employer with an explicit ownership acknowledgement.
2. A separate, active administrator belonging to that exact employer confirms
   the allocation. Agency administrators and platform admins cannot confirm it.
3. Only that employer administrator or the eligible designated external-handoff
   owner may verify the saved mapping against the approved allocation.

This is an explicit two-party administrative ownership attestation, not a
Greenhouse organization-identity discovery or per-employer OAuth flow.
Platform staff must independently confirm account ownership before allocating
real connections. One connection cannot be allocated to multiple employers.
The connection, employer and account-reference identity of an existing binding
are immutable. Replacement needs separately reviewed future support.

Either administrator can locally disconnect it. Disconnect increments the
binding revision and disables reads; it does not revoke the project's upstream
OAuth grant. Reallocation of the same account requires fresh employer approval.
Binding status `active` is local authority, not a remote health claim.

### Scoped read-only verification

`GET/POST /jobs/:jobId/candidate-workflows/:workflowId/ats-verification` reuse
the job-access, candidate-visibility and employer-handoff gates.
Controls require exact workflow and binding revisions.
The API rejects unknown input fields and does not accept caller-supplied tenants,
actors, credentials, provider hosts or arbitrary URLs.

The SDK transport pins `greenhouse-harvest-partner`, selects an explicit
connection, allows only filtered GET requests to the three v3 list endpoints,
rejects redirects, bounds individual reads to 10 seconds and bodies to 2 MB.
The whole verification wait is bounded to 25 seconds. The SDK may refresh its
own connection identity on a 401; Lexy does not retry verification attempts.

The adapter requires positive safe integer identifiers, exact single-record
responses and matching application-to-job and application-to-candidate
relationships. Jobless prospects cannot verify a job-bound application.
Only identifiers leave the normalization layer.

The service rechecks actor authority, allocation, revisions, mapping and
connection presence before each read and after the last read. A final serialized
database fence discards results if local authority changed during I/O.
Revocation cannot undo an already-issued read, but cannot produce a current
verification receipt.

### Dated history, not permanent health

Each attempted verification saves an attributable identifier-only snapshot,
mapping hash, actor, workflow/binding revisions and final status:
`checking`, `verified`, `failed`, or `discarded`.
No raw provider body, profile, contact data, exception or credential is stored.
The staff UI shows the checked IDs, timestamp and whether the receipt still
matches the current local mapping and binding.

Idempotency keys are actor/input-bound: replay never repeats remote reads,
including failed attempts. A second pending request is rejected; abandoned
claims can be retired by a new request after a minute. Historical verification
does not prove that remote records remain unchanged.

Allocation/confirmation/disconnect controls also append workflow audit events.
The tables are server-private (forced RLS and no public/app-role privileges).
Candidate receipts participate in erasure and have cascade foreign keys.

### Explicit read-only preview

`POST /jobs/:jobId/candidate-workflows/:workflowId/ats-preview` requires the same
eligible employer-handoff authority and exact binding/workflow revisions.
It is user-triggered, not polled, and reads only the saved mapped job and up to
25 of its applications per page. It is not an account-wide job browser.
Legacy confidential jobs, jobless prospects, malformed results and applications
that do not belong to that job fail closed. No candidate contact information,
application answers, job notes or raw provider payload is returned or stored.

Harvest continuation follows the documented `Link: ...; rel="next"` header.
Only the fixed HTTPS Harvest host, applications path and sole cursor parameter
are accepted. Lexy encrypts the opaque provider cursor into a ten-minute,
actor/tenant/workflow/mapping/revision-bound capability. Tokens are process-local;
expiry, server restart or moving to another process requires restarting from the
first page. Raw browser-supplied provider cursors are never forwarded.
Loading provider pages remains transient: no DB writes or local storage.
The UI drops previous pages/selections on new requests, errors or local
binding/workflow revisions. Saving selected metadata requires a separate explicit
import action and acknowledgement.

Account presence and local authority are rechecked before each read and after
the response, with a final database locking fence. Provider failure does not
retry automatically or leak raw exceptions. Historical preview metadata is
not proof of current remote state.

### Explicit metadata intake

`GET/POST /jobs/:jobId/candidate-workflows/:workflowId/ats-imports` expose a
separate persisted metadata view for the currently authorized mapped job.
The selection proof expires after ten minutes and is bound to the actor,
tenant, workflow, binding revision, workflow revision, job and exact previewed
application snapshots. A caller cannot substitute unseen IDs or provider data.
Import re-reads the job and up to ten explicitly selected applications with
bounded GETs, rejects changed snapshots, and rechecks authority before the
atomic local insert. Provider failure or local revocation saves nothing.

The unique employer/account/application key prevents duplicate intake, including
replays. An existing application cannot silently move between local jobs or be
remapped to another external candidate. Repeat intake does not overwrite its
original snapshot; refreshing metadata is a separate explicit control.
The saved record carries its importing actor, source workflow and observation/
import timestamps. Reads return up to 100 newest records and flag truncation.

This is **metadata intake**, not candidate-profile ingestion. It stores
allowlisted job and application metadata only, does not create native candidates
or applications, does not change hiring stages or decisions, does not fire
agents or messages, and cannot approve or send offers. The source workflow
foreign key cascades deletion of its imported records. The table is server-only,
forced-RLS with public/app-role privileges revoked.

### Explicit refresh checkpoints and history

Imported records now offer a manual **Refresh from Greenhouse** action and local
history. Each refresh re-reads only that record's job and application through
bounded Harvest GETs; it does not browse or discover additional applicants.
The exact employer binding, workflow and record revisions are required.
Application identity and its original external job/person relationship cannot
change implicitly. Authority and connection presence are rechecked throughout
I/O and inside the serialized final database transaction.

Successful reads append an attributable, dated observation and advance the
record's refresh revision. The initial import snapshot is immutable; the current
display uses the last validated snapshot. A same-key replay after success
does not repeat provider reads or create another observation. Competing refreshes
with the same expected revision cannot both commit. Failures do not change the
last successful checkpoint or fabricate fresh metadata.

An exact empty application response is recorded as **unavailable at that check**,
not deleted, rejected or withdrawn. Last-known details remain explicitly labelled,
and a later successful check can restore availability. HTTP errors, invalid
responses, confidential/missing jobs, foreign-job records and person remapping
are not empty-success evidence. They produce a reviewable error without a new
checkpoint. History shows the baseline plus the twenty latest refresh checks;
older observations remain stored and truncation is announced.

The imported-records screen also supports an explicit selection of up to ten
records for a sequential manual batch. This is an operational per-action bound,
not an entitlement or paid-access restriction. It calls the same per-record
endpoint with frozen binding/workflow/record revisions and distinct idempotency
keys. Each successful record checkpoint commits independently; the batch is
not atomic. The first failed or unconfirmed check stops the remaining queue,
without automatic retries. A successful unavailable observation does not stop
other selected records. An explicit stop allows the current request to finish
but starts no further requests. Leaving the page or changing authority/scope
also prevents subsequent requests and ignores late UI/cache updates.

Batch progress is page-session state, not a durable/resumable background job.
After reload/navigation, the existing persisted per-record timestamps and
histories show what actually committed. The synchronization summary counts only
the listed imports, announces list truncation and reports the latest saved check;
it is neither employer-account-wide coverage nor proof of current provider health.
Single-record checks and batch execution disable one another in the local UI.

The manual controls are not durable background jobs. Optional scheduled checks
are a separate employer-approved capability described below; neither path is
candidate-profile ingestion.
It cannot change native pipeline stages, decisions, messages, fees or offers.
History reads are local and provider-free. The observation foreign key cascades
through its imported record and source workflow on deletion.

## Optional employer-approved scheduled refresh

Only an active administrator of the exact employer tenant may approve, change
or pause a schedule. Platform possession of a connector or a designated
recruiter's manual-read permission does not grant ongoing background-read
authority. There is no default schedule. The administrator explicitly chooses
1–10 already imported records and hourly, six-hourly or daily checks, and
acknowledges recurring provider reads. The first check becomes due after that
interval; the minute worker scan is approximate, not a punctual booking promise.
Schedules and the latest twenty run results are persisted and survive reloads.

Approval binds the current workflow revision, employer binding, connection,
external account and mapping. The worker resolves current job access and
candidate privacy, then rechecks current employer-admin authority before reads
and inside each final metadata checkpoint transaction. It cannot follow a new
binding, mapping or owner silently. Changes require explicit reapproval.

A dedicated PostgreSQL session advisory lock excludes overlapping workers,
including recovery; the session is destroyed on release so a live lock is never
returned to the pool. Each run and its per-record revisions/outcomes are saved.
The database also allows only one running row per schedule. Checkpoints commit
independently. A missing application is a valid unavailable observation, not
deletion; it does not stop other selected checks.

Explicit pause increments the schedule revision under the same employer/workflow
lock used for final metadata commits. In-flight remote reads may finish, but
late commits and further reads fail the schedule/run fence. The first failed or
unconfirmed check stops the queue and pauses the schedule. Lost admin access,
changed revisions, disconnected bindings and missing selected records also pause
work rather than obtaining a replacement grant.

When a worker loses its session or exits, the next lock holder marks any
abandoned run interrupted and pauses its schedule without replaying provider
calls. An in-flight item is unconfirmed, not declared failed or rolled back:
its metadata checkpoint may already exist. Staff must inspect record history
before explicitly reapproving. No automatic retry, native profile ingestion,
hiring-stage mutation, candidate message, offer or fee action is introduced.

## Employer-declared hiring-stage ownership

Offer routing and stage ownership are separate. An external offer handoff alone
does not freeze Lexy's pipeline. The workflow's always-visible stage-authority
panel lets an active administrator of the exact employer explicitly declare
external control for a currently approved mapped ATS account. Each declaration
requires current workflow, ownership and binding revisions, acknowledgement, a
reason and an idempotency key. Other authorized staff may read the declaration
but cannot assign or release it.

The persisted declaration applies to the candidate/job pair across workflow
versions and application row tenants. Every normal stage transition goes through
the canonical stage choke-point, which checks external ownership before any
patch, stage, event or audit write. This includes human, candidate, agent and
system actors, same-stage commands and manual skip-automation moves. Stage
commands cannot reassign their candidate/job identity to avoid the guard.
Unrelated native candidates remain unaffected.

Ownership changes and transitions share a candidate/job advisory lock, acquired
before job/row locks. Native HTTP transitions use the app-role database handle:
the restricted security-definer predicate exposes only the policy boolean rather
than granting direct access to private workflow rows. The migration requires a
BYPASSRLS/superuser function owner and fixes its search path. Forced RLS and table
privileges remain unchanged.

Initial application and normalized sourced-row inserts bypass the transition
choke-point, so database insert triggers enforce the same ownership policy and
lock. This is not a general raw-SQL UPDATE fence: normal transitions remain
enforced by the existing canonical-write CI guard. Authorized privacy/erasure
bookkeeping and unrelated non-stage edits are not converted into hiring actions
or blocked by this ownership declaration.

The same initial-association guard applies when a previously unlinked row is
normalized or reassigned to an owned candidate/job pair. Unchanged identities,
non-stage metadata and privacy-related identity clearing remain permitted.

Interview completion is evidence, not a hiring-stage decision. If an
ATS-controlled candidate completes an AI interview, the optional native stage
move is explicitly skipped and logged while the completed interview, grading and
downstream evidence still finish. Other persistence errors are not swallowed.

Disconnecting a connector, changing offer routing, cancelling a workflow or
changing mappings never implicitly returns stage authority to Lexy. The exact
employer administrator can explicitly release the declaration from its owning
workflow even without provider access. Release records history and restores the
existing permissions and automation rules for future native moves; it does not
move the current stage, replay a provider action, import a profile, send an offer
or claim an ATS synchronization result. Declarations increment workflow revision,
so previously approved read schedules require review rather than silently
adopting the new revision.

### Migration prerequisite
Migration `0095_ats_stage_initial_write_guard.sql` installs the ownership-policy
predicate and initial-row triggers. Apply it using the privileged migration
owner **before** releasing the new API code: missing policy functions fail
closed, including on otherwise native transitions. It has been applied and
role-tested in verified development only. A schema push does not substitute for
this custom-function/trigger migration.

## Database rollout

Migration `0091_ats_verification.sql` is additive and applied to the independently
identified **development** database only. It adds employer allocations and
mapping-verification receipts, private permissions and write barriers.
Production schema rollout is still separate. Do not use a blanket Drizzle push:
this project has a custom RLS/security layer.
Migration `0092_ats_imports.sql` adds the private metadata intake table and is
also applied to **development only**. It does not change existing candidates,
applications, billing or model configuration.
Migration `0093_ats_import_refresh.sql` adds refresh state and a private
forced-RLS observation table with app/public privileges revoked. It is applied
to **development only**; production rollout remains separate.
Migration `0094_ats_refresh_schedules.sql` adds private schedules and durable run
outcomes, forced RLS and revoked app/public privileges, cascade deletion through
the workflow, and a unique active-run constraint. Applied to verified development
only; production rollout is still separate.

## Local verification

- Connector/adapter/transport/preview suite: 33 tests.
- Existing PostgreSQL/HTTP workflow suite extended with the ATS journey:
  52 tests, including existing controlled offers and manual handoff regressions.
- Outbound-request guards and injected transports prevent real Greenhouse calls.
- The browser check uses the actual component and hooks with fixture API
  responses; it is not provider acceptance or full signed-in app acceptance.

## Remaining work

- Connect a real Harvest account; verify account ownership, required scopes and
  the catalog transport's actual v3 behavior in a controlled live acceptance.
- Apply and verify production migration through the project's approved process.
- Extend the explicitly configured selected-record schedules only after
  real-account acceptance. Reviewed single-profile intake and saved read-only
  stage visibility are implemented below; broad candidate-profile synchronization,
  account-wide browsing and ATS writeback remain outside that scope.
- Add reviewed evidence writeback separately; retain external ATS authority over
  hiring stages and the single employer-human-owned offer process.

## Approved candidate profile intake

Selected imported application records expose a separate profile intake action.
This is not account-wide candidate browsing or automatic profile synchronization.
The current employer tenant administrator must explicitly authorize the read,
review a ten-minute encrypted preview, and confirm the local import. The source
workflow/job, account binding and import revisions are checked again at commit.
The preview re-reads the selected job, application and candidate through the
existing fixed Harvest v3 gateway; unavailable, private, contact-restricted,
mismatched and malformed records fail closed. Initial unchecked metadata can
be previewed; metadata with a known failed refresh must first be refreshed.

Only name and one reviewed email are copied by default. Current title/company
are optional. No attachments, phone/address/custom-field data, protected
attributes, account credentials, consent, scores or employee flags are imported.
Native profiles stay employer-local. No application, hiring stage, workflow
enrollment, candidate email, provider write or offer is created by intake.

Known ATS mappings and existing imported-person provenance take precedence over
email changes. Email aliases are checked within the exact employer tenant;
ambiguous identities require review. Existing profiles require explicit linking
and are never overwritten. Provenance is unique per employer/provider/account/
external person, and concurrent commits and request-key reuse cannot create
duplicate imported identities. GET restores the current linked receipt after
reload without a provider read. Current privacy/authority failures hide stale UI.

Migration `0096_ats_candidate_profiles.sql` adds forced-RLS, server-private
provenance with candidate-delete cascading and no contact payload. It is applied
to the independently verified development target only. Apply it through the
approved production migration process before publishing this code. Candidate
erasure deletes provenance and indirect imported metadata/observations before
their parent links and retains only a scoped hashed ATS-identity tombstone to
prevent future re-import. A new local profile uses the canonical privacy seal,
not workflow eligibility: requiring a job application merely to display a
profile would incorrectly turn intake into hiring enrollment.

Fixture HTTP/database and browser-component tests are development evidence,
not acceptance against a real employer Greenhouse account.

## Read-only ATS stage visibility

Each imported application displays its saved Greenhouse stage and raw external
application status, explicitly separate from the native Lexy workflow. This
reuses the authorized imported-record read and existing manual/scheduled refresh
mechanisms; displaying a stage does not trigger provider reads or write-back.

The UI labels a successful saved check as recent only within 24 hours, and
explicitly says it is not live. At 24 hours it becomes outdated; the label
updates every minute while the page is open. This is a display policy, not a
provider SLA or a guarantee that the remote stage has not changed. Imports that
have never been refreshed are labelled as such.

Unavailable records retain explicitly labelled last-known values and the time
of the latest check, without inferring deletion, rejection or employment. The
latest unavailable check cannot timestamp the retained stage, so its successful
observation time is shown as unknown rather than using that failed-check time.
Existing per-record history remains available for dated evidence. Invalid or
future-skewed timestamps cannot establish freshness.

This feature creates no application, stage transition, offer or provider write.
It requires no new API contract or database migration. Focused display/render
tests are local evidence, not live Greenhouse acceptance.

## Release handoff checkpoint

On 2026-10-28, a fresh `pnpm test:assisted-baseline` run completed with all
42 validation groups passing and zero failures. This includes the backend
workflow journeys, 209 registered frontend logic/render tests, frontend and API
typechecks, controlled-offer and calendar browser checks, API build/security
guards, lint and formatting. The earlier formatting failure is resolved.
These are local/fixture-based regression results, not production-schema proof
or acceptance against a live employer Greenhouse account.

The two remaining release checks for this increment are separate from completed
local implementation:

1. **Production schema verification and authorized rollout.** First identify the
   production database and inspect its actual migration/security state using
   read-only access. Reconcile the ATS prerequisites through migrations
   `0091`–`0097`, including custom functions/triggers and private-table permissions.
   Development application is not production evidence. Do not run a blanket
   schema push, assume publishing migrates an external database, or execute
   production changes without rollout authorization.
2. **Real employer Greenhouse acceptance.** With an authorized employer account
   and isolated approved requisition, verify the actual Harvest v3 transport,
   reviewed profile intake, existing-identity linking, stage refresh, unavailable
   records and access revocation. Record actual receipts and verify no provider
   write, native stage transition, candidate message or offer was triggered.

Neither release check was completed during this local closeout. This checkpoint is for
the Greenhouse intake/read-only stage increment, not a claim that every Lexy
integration or the entire platform is production-certified.

### Read-only production-target discovery — 2026-10-28

Production discovery was attempted without writes or publication:

- The deployment service reports no active publication for this workspace.
- The production SQL tool reports that this project has no production database.
- Secret-existence metadata confirms `DATABASE_URL` is configured, but that
  alone does not identify it as the actual production target. No connection
  strings or credentials were read or displayed.

This establishes a target-access blocker, not missing production tables and not
proof that Lexy's separately hosted live service is unpublished. Do not substitute
the development connection and label its catalog as production evidence. To
continue, identify the production-hosting Replit project or external deployment
and its approved read-only database access/reporting path. The production ATS
tables, columns, functions, triggers, grants and RLS remain unverified.

### External-host read-only ATS audit

The owner confirmed external production hosting. The existing schema-audit
command now supports a separate ATS scope. Run it from the matching source
checkout on the production host, with dependencies installed and its existing
production `DATABASE_URL` already configured:

```sh
node scripts/check-recent-db-schema.mjs --ats > /tmp/lexy-ats-schema-report.json
```

Share the JSON report, not connection strings or secret values. The command
inspects catalog metadata inside a verified repeatable-read, read-only
transaction and always rolls it back. It runs no migrations, reads no candidate
records, performs no provider requests and sends no messages. It does not change
environment settings.

The ATS scope checks 135 metadata conditions covering the seven private ATS
tables, runtime column types/defaults, constraints, unique/partial indexes,
forced RLS, policy absence, effective request-role/column privileges, erasure
dependencies and ownership function/trigger definitions. Function checks also
verify search paths, execution grants and privileged ownership where required.
Unlike information-schema visibility, the column audit does not require SELECT
grants on private application tables.

Exit codes: `0` means all scoped checks passed; `1` means metadata differs or is
missing; `2` means verification could not complete. An incomplete/nonboolean
result or writable transaction is never accepted as a pass. The report keeps
`targetEnvironment: "not-independently-attested"` because a connection string's
presence cannot prove production identity; the production operator must confirm
where it ran. A difference is a review finding, not permission to blindly apply
migrations or alter live data/security.

The query and command pass against development. Production remains unverified
until an operator runs this on the confirmed external target and returns the
report. The real-employer Greenhouse acceptance check remains separate.

### Profile-link erasure barrier follow-up — 2026-10-28

The broader scheduling/erasure audit found a missing write barrier on
`ats_candidate_profiles`. Private RLS/grants, application checks and cascading
deletion do not replace database protection against late writes. The earlier
134-check ATS-only contract did not require this trigger.

Additive migration `0097_ats_profile_erasure_barrier.sql` attaches the existing
shared barrier before inserts and updates; it does not change permissions,
models, hiring stages, subscriptions or the shared erasure implementation.
It was applied only after matching the configured connection to the independently
identified development database. Production application remains pending and
belongs in the approved rollout inventory after `0096`.

Both actual read-only audits now pass in development: the broader audit passes
210 checks and the updated ATS contract passes 135. All 21 checker unit tests
and eight database erasure tests pass, including active profile-link insert/update
controls, blocked late inserts/updates, rollback, ordinary-role enforcement and
an existing waiting-writer race. The new profile-link test rolls its changes back.
These focused follow-up checks are separate from the earlier full 42-group
baseline run; they are not a newly executed full baseline or production evidence.

### Mandatory installed-schema checks in the release gate

`pnpm test:assisted-baseline` now runs both `recent-database-schema` and
`ats-database-schema` as required steps, before the API fixture journeys. Both use
the existing outbound-request guard and read-only checker; any nonzero exit is
recorded as a failed required check, not an optional warning. No migration or
environment modification is performed.

This closes the gap between passing schema-checker unit fixtures and actually
checking the installed database protections. The exact guarded commands pass
against the verified development connection (210 broader checks and 135 ATS
checks). All 43 gate-plumbing/checker tests pass, including registration of both
mandatory commands exactly once and before database fixture journeys.

The configured gate now has 44 reporting groups. The last complete whole-gate
report remains the earlier 42-group run; the new steps and wiring were verified
separately, without repeating the browser suite or claiming a fresh 44-group run.
These checks still do not establish production identity or live ATS acceptance.

### PostgreSQL security-drift counterexamples — 2026-10-28

`scripts/ats-db-schema-sql-fixture.mjs` generates, but never connects or executes,
a development-only rollback fixture for the exact combined operational ATS
catalog query. The fixture uses empty tables in a unique private schema and
harmless test-local function bodies. It does not install or run production hiring
or erasure functions, write candidate records, change global roles, or contact
providers.

Actual execution through the explicitly identified development database passed:

- **72 deliberate defects**, each producing exactly the expected failed check.
- **73 intact-fixture checkpoints**, including the initial state and a restored
  all-135-check pass after every negative-case rollback.
- An intentionally wrong instance fingerprint was rejected before schema DDL.
- Both primary and shadow namespaces were independently confirmed absent after
  rollback, for the successful and rejected executions.

Counterexamples cover disabled/unforced RLS, table and column grants, unexpected
policies, unsafe security-definer modes/owners/search paths, changed function
bodies and execution grants, safe overloads and same-name shadow-schema decoys,
disabled/replica-only/conditional/misbound triggers, missing insert protection,
incorrect update columns/arguments, missing profile erasure barriers, all reviewed
indexes, weakened uniqueness and the active-run partial predicate.

The six generator/safety tests are registered in the existing gate-plumbing
group. They check identity validation, private/rollback-only scope, unchanged
operational contracts, independent expected failures/checkpoints, distinct
namespaces, bounded transport size and safe CLI argument handling. The full SQL
experiment is separate evidence, not something those generator unit tests claim
to execute. The overall gate remains 44 configured groups; this is not a fresh
whole-gate or production acceptance result.

To reproduce, obtain the expected fingerprint with the exported
`developmentFingerprintSql` using the explicit development handle. Generate SQL
with `node scripts/ats-db-schema-sql-fixture.mjs DEVELOPMENT_FINGERPRINT`, then
execute the entire generated script through that same identified development
handle in one call. Never split the transaction across database-tool calls,
remove the target guard/rollback, or substitute an unconfirmed application or
production connection.

### Release-gate failure-reporting regression — 2026-10-28

The production gate now shares its command/report lifecycle through
`scripts/assisted-baseline-runner.mjs`. Its subprocess regression tests use that
same runner with harmless local commands; they neither execute the schema
audits nor connect to application databases or live providers. There is no
production CLI switch, environment override, skipped audit, or alternate
success path added for these tests.

Eleven new regressions pass, including real child-process failures for either
mandatory schema audit, simultaneous audit failures, and successful later
commands that must not erase earlier failures. They also cover success-looking
stdout paired with a nonzero exit, retained command logs and child exit codes,
missing executables, signal termination, timeouts, an interrupted replacement
of a previously green report, final report-write failure and an empty run.
Spawn errors now retain their error codes alongside existing exit/signal/time
metadata.

The final process exit uses the saved report's strict, nonempty success
definition. This removes the empty-array `every()` discrepancy where an empty
completed report would say failed but the old final exit expression said zero.
Interrupted or unwritable final reports remain incomplete, not green.

All **60 gate-plumbing/checker tests** passed together after this change. The
gate still has **44 configured reporting groups** and retains its validation
lock, both mandatory guarded schema commands, command timeout, logs and all
later checks. This focused subprocess verification is not a new full-gate
execution or proof of production schema identity or live provider acceptance.

### Completed integrated local release gate — 2026-10-28

The updated `pnpm test:assisted-baseline` completed with **44/44 reporting
groups passed, zero failures**, including both mandatory database audits and
the shared command-runner regressions. It started at
`2026-10-28T07:48:46.570Z` and finished at `2026-10-28T08:02:07.622Z`.
Session evidence: `/tmp/lexy-assisted-baseline-yE6vOi/summary.json`.

This complete run includes 60 gate-plumbing/checker tests, five egress-guard
tests, all 25 API batches covering 86 files, 209 frontend logic tests, both
strict typechecks, API build/security guards, all eight registered browser
checks, lint with zero errors/new fingerprints, and formatting with zero
rejected files. Earlier statements that only a 42-group whole run was available
are historical and superseded by this result.

This is integrated **local** regression evidence. It does not complete the
external-host production schema/rollout checks, real-account calendar or
Greenhouse acceptance, Linx acceptance, or AWS live-delivery/file checks.
The SQL-level negative fixtures remain separate previously verified evidence.

## API references

New integrations use Harvest v3 with Bearer/OAuth authorization. Partner OAuth
authorization-code and single-account custom client-credentials flows are
different; do not copy obsolete v1 Basic-auth examples.

- https://support.greenhouse.io/hc/en-us/articles/360029266032-Harvest-API-overview
- https://harvestdocs.greenhouse.io/docs/authentication
- https://harvestdocs.greenhouse.io/reference/get_v3-jobs
- https://harvestdocs.greenhouse.io/reference/get_v3-candidates
- https://harvestdocs.greenhouse.io/reference/get_v3-applications
- https://harvestdocs.greenhouse.io/docs/pagination
