# Scheduling: locally verified work and remaining builds

## Repeatable panel-invitation browser regression — 2026-10-24

`pnpm run test:panel-invitation-browser` now renders the real panel invitation
component, auth provider and generated API client in an isolated loopback Vite
server. All 14 scenarios passed together; log:
`/tmp/panel-invitation-browser-final.log`.

The suite covers:

- No send on mount, read, review, cancel, reopen or freshness-clock ticks.
- Explicit delayed double-click produces exactly one approved POST, with the
  expected version/token and no extra caller-controlled fields.
- Accepted receipt survives reopening and browser reload without another POST;
  copy distinguishes Microsoft acceptance from delivery and guest RSVP.
- Failed 409/503 reads discard cached approval; expired reads close an open
  review and require deliberate reload.
- Changed GET approval token or panel recipient cancels an open review and
  requires review of the new details before sending. The background reload is
  deliberately injected through the real DOM handler; it is not a claim that a
  user can click through the review modal or that the component polls.
- Lost, token-mismatched or roster-mismatched receipts never show immediate
  success or retry; matching later reads can recover the accepted receipt.
- Non-accepted outcomes remain read-only after reload.
- A late prior-user GET cannot replace the new user's status, and changed
  schedule revisions invalidate review.
- At 390px, recipients remain readable and the final confirmation is reachable.
- Unknown API writes, unapproved invitation writes and non-API writes are
  rejected. The denial boundary is exercised on both the first and an additional
  guarded page; remote connections are blocked by fixture CSP.

The runner uses a temporary dependency cache, no API proxy, fresh browser
contexts, guarded page creation, no service workers/popups/frames, disabled
fixture-only animations and explicit per-scenario time budgets. It is also
launched with the existing Node egress guard and Chromium pipe transport.
The fixture is development-only and is not imported by the app router.

The four existing pure panel-state tests passed and are now included in the
frontend release manifest. Frontend strict typecheck, scoped lint, repository
formatting, gate script syntax and whitespace checks passed. No application
behavior, backend, schema, AI configuration or billing behavior changed.

The browser command is now a required assisted-baseline step. The last complete
whole-gate evidence below remains the prior 30-check run; this addition was
verified with its exact registered command and focused checks, not represented
as a new complete 31-check execution. The full expanded gate must run for the
actual release.

This closes the formerly browser-unverified changed-details case locally.
It does not prove server authorization, calendar permissions, Microsoft
`hideAttendees` behavior, actual delivery or guest acceptance. Real Outlook
and verified production migration acceptance remain pending.

## Release-check cleanup — 2026-10-24

This supersedes the earlier notes that repository assisted/format gates remained
failing. The completed focused release gate is now green, not merely in progress:

- `assisted-baseline`: **30/30 required checks passed, zero failed**.
- API regression: **789 passing tests in 68 files across 20 bounded batches**.
- Frontend logic: **174 passing tests**.
- Gate/checker plumbing: **35 passing tests**, plus **five egress-guard tests**.
- Frontend and API strict typechecks, API build/security guards and the existing
  controlled-offer browser check passed.
- Lint: zero errors and zero new error fingerprints. Existing nonblocking
  warnings are not claimed resolved.
- Repository formatting: zero rejected files; the standalone `format` workflow
  also passed. Ignore lists, quality allowances and security guards were not
  weakened.

Evidence: `/tmp/lexy-assisted-baseline-C77rRg/summary.json`; started
`2026-10-24T05:14:25.870Z`, completed `2026-10-24T05:25:17.086Z`, status `passed`,
`complete: true`. The temporary logs are session evidence, not durable production
attestation; the result and scope are retained here.

The route-isolation test now supplies the panel validator dependency introduced
by the real confirmation route and asserts it runs before writes on the same
transaction. It also checks that panel rejection/unavailability produces no
confirmation write or notification. The SQL assertion follows the route's
`clock_timestamp()` check. This repairs the harness without bypassing runtime
panel validation; real consent/availability behavior remains the responsibility
of the separate PostgreSQL/HTTP suite. The other source edits are configured
formatter output, not scheduling behavior changes.

No new migrations, production writes, LLM/prompt/provider changes or entitlement
changes were made in this cleanup. A green focused gate is not complete product
or real-provider acceptance. See the
[release and live acceptance checklist](../ops/scheduling-release-checklist.md)
for the still-pending target rollout and authorized real Outlook test.

## Staff-approved saved-panel invitations — 2026-10-24

The coordinator now exposes **Invite panel** for confirmed human interviews.
A read-only review resolves the current saved panel, sharing grants, connected
organizer mailbox, candidate email, local working hours and calendar availability.
The final approval binds the exact schedule, candidate, organizer and panel
mailbox/recipient snapshot. The server requires literal approval and rejects
extra request fields; generated boolean validation alone is not sufficient.

The new action creates one organizer-owned Outlook guest meeting with the
candidate and panel recipients; the organizer is not duplicated as a guest.
Microsoft's `hideAttendees` setting keeps other guests hidden from invitees.
Provider receipts and read-only reconciliation verify the complete guest set,
time and attendee-privacy setting. Acceptance means Microsoft accepted the
meeting request, not email delivery, an RSVP or a guaranteed reservation on
every attendee's calendar.

Panel and candidate-only actions share the existing one-attempt-per-schedule
ledger. A committed attempt precedes the provider write. Lost replies remain
review cases; status reads can recover an exact provider receipt but never send.
Concurrent clicks, changed recipients/mailboxes/consent, stale approvals and
unknown availability cannot silently send a new invitation. Candidate-only
sending rejects active saved panels. Existing guest meetings and linked holds
are not converted or replaced by the panel action; subsequent panel-meeting
changes remain human-managed in Outlook.

Migration `0086_panel_invitation_snapshot.sql` adds private snapshot evidence
to the existing protected invitation ledger and was applied only to a verified
development target. It preserves existing RLS, permissions and the erasure
barrier. Production migration and actual Microsoft multi-mailbox acceptance
remain unverified. No real panel invitation was sent by verification.

Verification: the full isolated PostgreSQL/HTTP suite passed 94 scenarios.
The six panel cases also passed a focused follow-on after approval/authorization
hardening; strict malformed-approval rejection has an additional focused check.
Calendar/invitation unit checks passed 23 scenarios; invitation frontend logic
passed eight; frontend production build, both typechecks and API build guards
passed. The metadata check additionally found and corrected an existing
`integer` versus PostgreSQL catalog `int4` expectation for panel buffers.
Repository-wide assisted/format gates are not claimed closed by this feature.

The mock-only browser pass verified explicit review, one POST on delayed
double-click, accepted receipt persistence across reload/reopen, ambiguous
response read-only recovery, mismatched token/roster rejection, GET failure
blocking and reachable 390px controls. A changed GET token/recipient cancelling
an already-open review was not browser-verified; the state comparison/invalidation
is source-reviewed and covered by pure comparison tests, not claimed as a full
browser pass. No real account, API write or provider was exercised.
The final development metadata run passed all 187 checks, with ten checker
unit tests passing.

## Personal panel working hours — 2026-10-23

Staff can maintain their own optional working hours in Settings, independently
of Outlook connection or panel-sharing consent. The private preferences contain
an IANA time zone and up to 14 non-overlapping weekly intervals, with split
shifts, off days and explicit all-week closure. Overnight shifts are split at
24:00 into two local days. Unconfigured or explicitly cleared preferences add
no working-hour restriction: calendars are still checked and no default
Monday–Friday or 09:00–17:00 policy is invented.

Recruiters retain their existing personal Settings card. The shared Calendar
preferences entry at `/settings/calendar` also makes these own-account controls
available to hiring managers and interviewers, without widening recruiter or
administrative routes. Candidates are excluded from that route and the API.

Panel discovery filters the complete meeting and its before/after buffers
against every selected member's current local hours before applying the
suggestion limit. Checks walk actual instants through daylight-saving gaps,
repeated hours and local-date changes, including half/quarter-hour zones. The
existing saved-panel guard applies the same rule to time saves and confirmations;
changing preferences does not itself move an appointment or contact a candidate.
These are availability preferences, not a new invitation approval or reservation.

Only the signed-in stored staff identity can read/write this endpoint. Candidate
and public booking responses still omit preferences and calendars. The forced-RLS
private table has no public/request-role grants. Shared member locks and exclusive
self-edit locks serialize preference changes, including first-time configuration,
against a panel check. Missing security protections or invalid stored policies
mean unknown availability, not unrestricted or partial-panel success.

Saves use a private revision and reject stale or concurrent writes. Clearing
retains a fresh revision rather than deleting the record. Settings display a
separate saved summary, keep dirty drafts through failures/refetches, disable
stale/unknown writes and recover uncertain outcomes through explicit reads.
They do not silently retry a PUT.

Migration `0085_calendar_working_hours.sql` was applied only through the verified
development handle. Production migration and real multi-mailbox Outlook/team
acceptance remain pending; no provider meeting or email was created by this
feature's verification.

Verification: all 88 isolated PostgreSQL/HTTP scenarios passed together, plus
14 working-hour/slot unit tests and nine schema-contract tests. API build guards,
frontend typecheck/build and the frontend score-band source guard passed.
Repository-wide formatting is not claimed clean.

The mock-only browser pass verified the recruiter card's save/reload, split
shift/overlap validation, duplicate-submit lock, deliberate all-week closure,
explicit clear, ambiguous-save read-only recovery, fresh GET failure and mobile
layout. Cached-data GET failure and dirty-draft/external-version refresh could
not be triggered through browser focus events, so those two cases are
source-reviewed rather than claimed browser-verified. The shared staff page's
role gate and wiring were reviewed and typechecked; no real staff authentication
or Outlook provider was exercised by this browser pass.

## Retained panels and booking-time checks — 2026-10-23

This supersedes the initial finder-only limitation below. Staff can now save a
reviewed panel at the current interview time or at a common suggestion, and
deliberately remove the panel without moving the time. Saving is atomic with
the native proposal. It resets the appointment to pending so the candidate
must confirm the reviewed proposal again; it neither publishes extra
alternative slots nor sends/updates an Outlook invitation.

The saved panel is displayed independently of the search draft and is loaded
again after navigation/reload. Read errors mean unknown, not “no panel.”
Provider/consent conflicts leave the existing panel and time intact. Writes
require the displayed native revision, an authorised coordinator, current
member scope, mailbox-bound sharing grants and whole-panel availability.
The primary interviewer, if assigned, must be included. Changing that primary
interviewer requires deliberate removal/review of the saved panel first.

The same private-panel guard now runs before native staff timing/activation
updates, before Outlook-to-native timing pulls, before candidate single-time
confirmation and in the shared offered-time chooser used by portal and public
booking links. No candidate path returns private panel identities or grants.
Unknown availability fails closed rather than accepting a partial panel.

Members and consent fingerprints live in a separate forced-RLS private table,
with no public or application-role table/column grants. Only a random panel
revision is attached to the native schedule. Public/candidate revisions use
that opaque value, never a digest of private identities. A deliberate removal
retains a revision tombstone: attach/remove cycles cannot revive an older
candidate proposal. Revoked and re-enabled sharing needs a fresh staff review;
it does not automatically revive an earlier saved grant.

Verification includes 81 isolated PostgreSQL/HTTP scenarios: 79 passed in the
full run, the corrected public-booking fixture passed its focused rerun, and an
additional shared staff-edit guard scenario passed separately. The latter
verifies conflict rollback and a valid changed-time/duration write; it is not
an HTTP journey through the large interview route. Schema-contract checks and
the API's build/typecheck/guards passed. The frontend production build passed
before the final draft-initialisation refinement. The source guard for bounded
polling also passed. Repository-wide formatting is not claimed clean.

Migration `0084_interview_schedule_panels.sql` was applied to the explicitly
verified development database only. Production migration and real
multi-mailbox acceptance remain external rollout checks. There is still no
provider reservation or panel invitation feature here. Existing provider
events, including holds, remain busy; the guard does not silently ignore events
by subject/name. Per-member working-hour preferences were added in the section above.

One mock-only browser pass verified explicit/double-click save, persisted names
and time after reload/navigation, failed-save draft preservation, lost-response
read-only recovery, cancelled and accepted removal, stale revisions, unknown
saved reads and a focus/roster refresh during a delayed write. The 390px layout
had no horizontal document overflow; the narrow native date input's display
was clipped. All authentication and APIs were intercepted; no real provider
or delivery was exercised. The final frontend typecheck and diff check passed.

## Staff-consented common panel times — 2026-10-23

Settings now has an explicit, staff-owned **Interview panel availability**
choice. Calendar OAuth alone does not opt anyone into panel searches. Sharing
is bound to the current organisational tenant and connected Microsoft mailbox;
switching mailbox requires explicit reconfirmation. Stop sharing does not need
a working calendar connection and leaves mail/calendar consent unchanged.

Each eligible upcoming human schedule in the coordinator has **Find common
panel times**. The directory contains active, opted-in staff from the relevant
organisational/work-order scope, not arbitrary tenant members or candidates.
Hiring managers must be assigned to that work order. An interviewer who opts
in can participate in common-time searches within their organisational scope;
that does not assign them to the interview or grant feedback/schedule access.

Staff deliberately select one to five people and a bounded local working
window, with a zero-to-sixty-minute buffer and a browser-time-zone label.
The server checks every selected calendar, queries the buffer-expanded window,
and returns up to forty common start/end suggestions. It returns no individual
busy periods, event names, attendees, mailbox identifiers or calendar contents.
Candidate endpoints expose none of this; candidate slots remain staff-published
proposals only.

Unknown/failed/malformed calendars cannot produce partial-panel “free” results.
Stale schedule revisions, revoked consent, changed mailbox, inactive staff,
unassigned managers and foreign scope are rejected. Shared consent/user and
schedule/privacy-row locks protect the bounded read against simultaneous
revocation and native edits. Inputs, directory changes and failed refreshes clear
stale browser results. Query state is isolated by signed-in staff identity.

This is a common-time finder, not panel booking. It does not persist a panel,
save a schedule, publish candidate choices, reserve a resource, add attendees
or send an invitation. Working hours are the explicit searcher's window, not
per-person preferences; staff must still review everyone’s local working hours
and follow the separate native save/offer/invitation actions.

Verification: six slot-calculation unit checks and 74 PostgreSQL/HTTP scheduling
scenarios, including a focused successful rerun after tightening the assigned
hiring-manager gate. The full suite's other 73 scenarios passed on its first
pass. Migration `0083_calendar_panel_consents.sql` was applied to the verified
development database only. Its staff-consent table has forced RLS, no public or
request-role table/column grants, and a user-delete cascade. Apply it to the
confirmed production target before rollout. Real multi-account Microsoft
acceptance remains a separate team check, not proven by the synthetic provider.

One mock-only browser pass covered desktop sharing consent/reconfirmation,
revocation with an unavailable connection, lost-response read recovery without
retrying the write, and unknown consent reads. At 390px, it also verified
two-member searches, double-click deduplication, input-change clearing, failed
search/directory clearing, stale and empty rosters, and an in-flight response
that must not repaint after a member is revoked. Authentication and all API
responses were intercepted; this does not prove real sign-in or Graph access.
The malformed-response browser branch was not separately exercised.

Library/API/frontend typechecks, the frontend production build, the API build
and its configured guards, scoped ESLint, and nine schema-contract tests passed.
Development catalog checks confirmed enabled/forced RLS, no policies and no
request-role table or column grants. Both managed workflows are running.
The pre-existing dormant-Stripe configuration warning still appears on API
startup; this work did not alter billing secrets or activate checkout.

## Human-approved existing Outlook invitation updates — 2026-10-23

The coordinator now has a separate **Update existing Outlook invitation**
action for a confirmed upcoming human interview. It displays the candidate,
connected organizer, existing Outlook time and saved Lexy time. **Review
update** is read-only; **Approve and update Outlook** authorizes a time-only
conditional PATCH to the original event. Native rescheduling, candidate
requests and request acknowledgement do not trigger this action automatically.

Approval binds the native revision, candidate/recipient, connected Microsoft
mailbox identity, original immutable event ID, provider ETag, old time and new
time/duration. Unexpected guests, recurring/cancelled/non-organizer events,
changed recipients, changed mailboxes, stale approvals and privacy/scope
failures cannot authorize a write. It never creates another event, adds
panelists, changes attendees or sends a fallback email.

Each change intent commits before Graph mutation. The original invitation
receipt is preserved and change history is retained. Concurrent or repeated
approval cannot PATCH twice. Lost responses require explicit status recovery;
provider reads can observe the intended updated meeting, but an unobserved
outcome stays under human review without automatically retrying. A subsequent
native proposal requires another fresh review and a separate change intent.
“Matches the saved time” is not proof of attendee delivery or acceptance.

Verification includes 66 PostgreSQL/HTTP scenarios across the full scheduling
suite and focused checks after fixes, including update races, stale native and
provider revisions, mailbox switching, event replacement, privacy/guest gates,
history retention and uncertain response recovery. Two new frontend receipt
tests pass. The initial HTTP pass exposed that generated validation ignored
the OpenAPI true-only approval constant; the route now explicitly rejects false
approval, with a successful focused HTTP regression check.

A mock-only browser pass at 390×844 confirmed the separate review and approval
steps, exact version-bound POST payload, one write on double-click, persisted
status after reopen/reload, saved-but-lost-response recovery by explicit reads,
and a stale-approval 409 remaining under human review. All API calls were
intercepted before page creation; no real sign-in, provider or candidate email
operation was used. Unrelated API reads and external requests were blocked.
Focus-triggered review invalidation was not exercised by that browser pass.

**Rollout:** migration
`lib/db/drizzle/0082_interview_calendar_invitation_changes.sql` was applied only
to the explicitly verified development database. It adds change history to the
existing server-private invitation receipt table, retaining RLS, revoked
request-role privileges and its erasure barrier. Apply the reviewed migration
to the confirmed production target before publishing this code. Live Microsoft
account acceptance and actual attendee delivery remain team checks, not proven
by the provider fixture.

## Candidate request withdrawal — 2026-10-23

Candidates can now explicitly withdraw an unreviewed request from the existing
portal or a currently valid, candidate-bound booking link. The original request
and proposal history remain stored. Withdrawal does not cancel, edit, reconfirm
or reserve the interview, and never changes a provider event or sends an email.
The candidate and coordinator share the persisted withdrawn state; reviewed
requests cannot be withdrawn and withdrawn requests cannot be acknowledged.

Both actions use the same schedule lock and scoped request predicates. A
database constraint also prohibits simultaneous reviewed and withdrawn states.
Same-request withdrawal retries preserve the first timestamp and do not repeat
the audit event or generic, current-staff-scoped in-app notices. The existing
one-request-per-proposal key remains consumed; retries never reactivate a
withdrawn request. A new proposal remains a separate request opportunity.

Verification completed:
- 57 real PostgreSQL/HTTP scheduling tests passed, including ten new withdrawal
  tests: duplicate/concurrent submissions, ownership and strict input rejection,
  withdrawal after review, review after withdrawal, a simultaneous review race,
  stale/cancelled proposals, invalid/revoked/expired public capabilities,
  notification rollback, direct constraint enforcement and preservation of an
  already confirmed appointment.
- Three receipt/parser unit tests passed.
- Three mocked browser scenarios passed: double-click withdrawal with one POST,
  reopen and full-page recovery; a persisted withdrawal with an aborted response;
  and a staff-review conflict followed by explicit reload. Each scenario made
  one withdrawal POST, without an automatic retry. The 390×844 dialog was checked.
  No choose, confirmation, calendar or invitation mutation was observed.
- These browser tests used synthetic public-page responses, not signed-in
  production accounts. Staff authorization and acknowledgement conflicts were
  verified by the real HTTP/database suite, not a signed-in coordinator browser.
- API/frontend typechecks and production builds passed. The API build's existing
  privacy/ownership guards passed. Touched-file lint had no errors; the existing
  ref-counter cleanup warning remains. Both managed services are running.

**Rollout:** `lib/db/drizzle/0081_interview_time_change_withdrawal.sql` was
applied only to the verified development database. Development catalog checks
confirmed the nullable column, validated review/withdrawal constraint, forced
RLS and no ordinary-role table or column access. Apply migration 0080 first if
the request table is not already present, then 0081, before publishing this code
against a separate production database. No production migration was performed.
Existing Outlook invitation updates are documented above; team calendar
acceptance remains separate.

## Candidate time-change requests — 2026-10-23

Implemented on **My Interviews**, valid public booking pages (including native
confirmation receipts), and the staff coordinator. Candidates submit a fixed
request for another proposal; no private availability, free-text notes or
calendar events are exposed. Upcoming pending and confirmed human interviews
are supported. A request neither cancels nor edits the appointment.

Requests are durable and bound to the current candidate, application and
candidate-visible proposal revision. Same-proposal retries return the existing
request without repeating action events or staff alerts. Native confirmation
and calendar invitation remain separate. Staff can read and acknowledge requests
within their existing job/tenant/assignment scope; acknowledgement is idempotent
and never reschedules or sends anything.

New requests and generic in-app notices commit atomically through the existing
current-staff recipient rules. No candidate identity, private notes or calendar
snapshot is included in those notices. The server-private request table forces
RLS, denies ordinary-role table and column privileges, uses the erasure write
barrier, and is included in candidate erasure cleanup.

Verification:
- 47 real PostgreSQL/HTTP scheduling tests passed in a private development
  fixture, including nine added request/privacy tests. Covered concurrent
  retries, foreign ownership, malformed identity fields, stale/cancelled/past
  proposals, scoped review, new proposal history, public capabilities, unchanged
  confirmed appointments, direct-role denial and atomic notification rollback.
- Two frontend receipt/state unit tests passed.
- Mocked browser flows passed for explicit save and duplicate-click protection,
  reopen/full-page recovery, a saved request with a lost response, and stale
  proposal rejection without an automatic retry. Desktop and phone layouts were
  checked. These tests do not establish live provider delivery.
- API/frontend typechecks and production builds passed, including API privacy
  and ownership guards. Touched-file lint had no errors (one ref-counter cleanup
  warning); no models, prompts, provider routing or paid-plan settings changed.
- API and web workflows started successfully. The pre-existing dormant-Stripe
  sentinel warning remains unrelated to this request workflow.

**Rollout:** Apply `lib/db/drizzle/0080_interview_time_change_requests.sql`
before publishing this code to a separate database. It was applied only to the
verified development target. Catalog checks returned enabled/forced RLS, no
ordinary-role table or column access, and the active erasure barrier. Do not
assume publishing migrates an external production database. Missing schema
returns a retryable request error, not a false success.

Withdrawal is covered by the subsequent implementation documented above.
Changing an existing Outlook guest meeting is covered by the later explicit
approval workflow documented above. Staff native reschedule controls remain
separate from provider meeting changes.

## Human-reviewed calendar invitation binding — 2026-10-23

The final invitation confirmation now displays and submits an immutable copy
of the recipient, schedule revision, instant and duration reviewed by staff.
Sending requires that copy to match current eligible details, plus a fresh
time/eligibility check at the click. A changed or failed refresh clears stale
review rather than restoring it automatically when reads recover.

Returned receipts must match those same reviewed details, not only email and
revision. A mismatch remains uncertain and does not enable automatic resend.
This changes client review safety only: server authorization, durable provider
intent, Microsoft consent, native booking and delivery semantics are unchanged.

Four unit cases passed, including recipient/schedule/revision/time/duration
changes in both review and accepted-receipt comparisons. Frontend typecheck,
production build, touched-file lint and formatting checks passed.

A temporary browser fixture mounted the real component and verified four
flows: deliberate two-step send with duplicate-click protection; recipient
change at the same native revision requiring fresh review; failed refresh and
recovery not restoring approval; and a same-instance schedule version/time
change closing stale review without a POST. All API responses were synthetic,
with no real email, sign-in, database or Graph access.

The initial mismatched-receipt browser checks were blocked by dialog
interaction timeouts. A subsequent single-case check used native DOM clicks
on the real component, not pointer hit-testing. One synthetic POST returned
an accepted receipt with the wrong duration; the real handler displayed
the uncertainty/do-not-resend warning. A test-script context error then
prevented the follow-on reload/reopen assertions. This is evidence of the
handler/error-rendering path, not a full browser recovery pass.

Separate deterministic checks evaluated the actual component's parsed
eligibility expression against its real compiled eligibility helper. An
attempted send stayed blocked after clearing read errors, even if a subsequent
status was `not_sent` and uncertainty was cleared. Source inspection confirmed
that the local attempt resets only in the schedule identity/version effect,
not on focus, status reload or same-key dialog reopening. These checks do not
substitute for browser recovery observations. That full recovery sequence and
repeatable calendar-invitation coverage remain separately outstanding.

## Reopened booking receipt freshness — 2026-10-23

Public booking pages now revalidate directly reopened confirmation receipts on
focus and the existing 30-second timer, even when no offered-time proposal was
previously displayed. Invalidated links replace the receipt, and a failed
revalidation replaces the current-confirmation claim with an explicit retry
state. A newly returned proposal requires explicit reload before confirmation.
Invalid links stop automatic reads.

Post-write recovery uses the same read-sequence fence as polling, focus and
explicit reload. A delayed recovery receipt cannot overwrite a newer
invalid-link result. This is a client freshness fix, not a change to server
booking permissions, available times, calendar access or delivery.

Five focused browser scenarios passed on the real page with synthetic responses:
focus invalidation of a reopened receipt; refresh failure and retry recovery;
delayed recovery versus a newer rejection; confirmed-to-offered stale blocking;
and timer revalidation with no further reads after invalidation. The initial
fixture setup needed context-level interception before opening each new page;
the remaining scenarios then passed without repeating the already verified
first case. Browser evidence is mocked UI behavior, not live provider or
database acceptance. No real booking was submitted.

The current frontend typecheck, production build, touched-file formatter check,
and mobile invalid-link rendering passed. No backend or schema changes were
made, and the queued release-test automation remains separate.

## Formatting and regression gate — 2026-10-23

The repository formatting gate and the full assisted regression gate now pass.
All 17 rejected scheduling files were normalized without adding formatter
ignores or expanding quality-baseline allowances. Formatting did not change
application rules, requests, AI configuration, or subscription access.

The broader run exposed a stale import-stripping route-test fixture after the
shared confirmation writer was introduced. The fixture now supplies that
dependency and asserts the same transaction, candidate, application, schedule
and confirmed status are delegated exactly once. It does not pretend to test
the writer's persistence; the separate PostgreSQL suite supplies that evidence.

Verified in the final assisted run: all 68 backend test files across 20 bounded
batches, 174 frontend logic tests, the controlled-offer browser checks, API and
frontend typechecks, API build/source guards, lint error gate and formatting.
The public booking page's missing-token state also rendered correctly after
restart. No migration or backfill was performed.

These checks do not establish production migration status, Microsoft calendar
consent, live provider delivery or Linx acceptance. The PostgreSQL scheduling
suite remains a separate verified-development check, not part of the assisted
baseline; repeatable scheduling-component browser coverage is also separate
from its controlled-offer browser check.

## Recruiter confirmation alerts

Native time confirmation now commits its action event and in-app staff notices
in the same database transaction. This shared writer covers signed-in original
time confirmation, signed-in alternatives, and public booking-link selection.
Public receipt recovery does not write another event or notice.

Recipients are active, currently designated recruiting staff and the assigned
interviewer, within the job tenant's ancestry. Current roster rows must belong
to the job's tenant. Candidates, inactive users, unrelated tenants and
unassigned hiring managers do not receive alerts. Employer tenant admins are
the fallback when there is no eligible recruiting owner, including when an
interviewer is assigned. Notification rows use each recipient's own tenant so
an agency recruiter's normal caller-only inbox can read them.

Alerts contain no candidate name, email, historical appointment time, calendar
details or booking capability. They link to the currently authorized coordinator
view, which focuses the requested schedule or reports that it is unavailable.
The copy says confirmed **in Lexy**, not candidate identity verified, Outlook
reserved, or invitation delivered. No external email or Graph call was added.

Development evidence: **38 PostgreSQL/request-context checks passed**, including
new recipient/fallback, caller-only inbox isolation, concurrent retry and
notification-insert rollback cases. The final recipient fallback adjustment
also passed the four focused notification cases. API and frontend typechecking
and frontend build passed; the managed API workflow rebuild includes its source
guards. No new migration or production data change is required for this feature.

## Controlled Outlook invitation addendum

After a native human interview is confirmed, authorized staff can review its
exact current candidate email, time/offset and duration, then explicitly confirm
**Send invitation**. Only the connected staff member's Outlook calendar is used,
with separate calendar consent. No invitation runs on native confirmation,
page load, focus, or an AI action. The candidate is the only guest; no staff
calendar or free/busy data is exposed.

A server-private send intent is committed before a provider mutation. The
schedule, application, approval and candidate privacy rows are revalidated and
locked while the bounded Graph write runs. Existing guest meetings are never
silently modified. An ambiguous result remains **Needs review**, with no
automatic resend. Read-only reconciliation may recover an accepted event.
“Outlook accepted” is deliberately not a delivery confirmation.

Development evidence: the PostgreSQL/request-context suite passed **34 checks**
(five new invitation cases), four mocked Graph operation tests and two pure
frontend state tests passed, typechecks and both builds passed, and the
read-only development schema check passed. Migration `0079` was applied only to
the explicitly verified development database. Graph was mocked in tests: this
does not prove live calendar consent, provider delivery or production rollout.

A single mocked browser pass of the real invitation component passed explicit
two-step confirmation, exact recipient/time display, duplicate-click protection,
accepted-versus-delivered wording, uncertainty/no-retry handling, and stale
revision blocking. All API requests were intercepted. This was an isolated
component check, not a signed-in staff journey or a live Microsoft test.

If a send attempt is uncertain, staff must inspect Outlook rather than repeat
the action. Guest meeting changes now have the separate human-approved action
documented above; cancellations remain human-owned in Outlook. The
personal-hold controls are not a guest meeting editor. Existing queued
work for panel calendars and booking races remains separate from this handoff.
Recruiter confirmation alerts are described above.

## Candidate booking-link addendum (native only)

An authorized staff member can create, replace or revoke one link per pending
human interview from the offered-times dialog. The candidate-facing page shows
only the original proposal and currently published alternatives; a bearer
fragment is transmitted only in the POST body. A selected choice atomically
records one native confirmation and candidate action event. A lost response can
be recovered from the consumed link; an incompatible replay is rejected.

Development-only evidence: 29 PostgreSQL/request-context integration checks
passed, including capability hashing, cross-tenant access, one-use replay,
parallel public choices, a race with signed-in confirmation, staff offer and
application changes (including change-and-restore), revoked/expired links,
unapproved jobs, erasure, rollback on event failure, and missing security hooks.
The API managed build and frontend build/typecheck passed, and the read-only
schema check passed against the verified development database. No live
candidate email, Graph calendar hold or invitation was sent as part of this
test. This does not attest that production has the migration or that a live
recipient owns a forwarded link.

## Existing native scheduling evidence

## Explicit alternative times in the signed-in candidate portal

Staff can now publish up to four alternative start times for an existing
pending human interview from the coordinator's **Offer times** action. The
original proposal remains offered; publishing an empty alternatives list
withdraws the alternatives, not the original proposal. All times share the
original duration. Availability is explicitly unchecked.

The candidate's **Choose an interview time** action fetches only their own
original time and active, deliberately published alternatives. Alternatives
expire at the earliest proposed start or seven days after publication,
whichever comes first. The proposal is bound to the current candidate,
application and public proposal revision. Rescheduling or reassignment cannot
transfer the old alternatives to a different proposal/person.

Selection locks the native schedule and authorization parents, rechecks
ownership/approval/erasure after lock waits, and atomically saves one chosen
time, its confirmed status and the candidate action event. The alternative set
is consumed in that transaction. The original single-time confirmation path
still competes on the same native row, so concurrent paths cannot both succeed.
An event-insert failure rolls back the time/status and preserves the offer.
Final writes use the database clock for future-time and expiry checks.

The server-private alternatives table has forced RLS, no request-role policies,
and no public/request-role privileges. Its candidate-linked erasure inventory
and existing late-write barrier are included in the reviewed migration. A
schedule deletion also cascades to its alternatives.

Verification so far: 17 real PostgreSQL/request-context tests passed, including
selection, revision mismatch, withdrawal/expiry, cross-candidate privacy,
competing confirmations, rollback and direct request-role access denial.
Six frontend logic tests passed in the default timezone and America/New_York;
API and frontend typechecking passed. The erasure drift check and API managed
build/security guards passed. The two changed large page files retain their
pre-existing formatting baseline rather than receiving unrelated rewrites.

A single synthetic, intercepted browser journey verified staff publication,
the exact PUT contract, candidate load-error recovery, a 409 conflict retaining
the selected option and blocking retry until reload, and successful selection
with the exact POST contract. The refreshed card showed the chosen time and
confirmed state without an AI room link. At 390px the dialog had no horizontal
overflow. All API calls in that pass were intercepted; this is UI-contract
evidence, not live database/provider acceptance. An anonymous app capture
correctly displayed sign-in.

This is **not** calendar reservation or candidate invitation delivery. It
creates no provider event and sends no email. It is authenticated portal
selection, not public candidate-bound booking links, panel scheduling or
cross-candidate resource reservation. A staff member still arranges the final
calendar details. Existing startup billing-sentinel alerts are unrelated and
were not changed by this work.

The development database has the additive migration applied. Before production
use, the actual deployment database needs the reviewed migration, including
the existing erasure-barrier function dependency, through its documented rollout.
No production database changes or deployment were performed.

### Missing-migration recovery and staff scope hardening

The offered-time endpoints now return a private-safe temporary-unavailability
503 when their own table or queried columns are missing. Candidates see the
server's useful retry/contact-recruiter message rather than a generic read
failure. This is not a successful empty offer list, confirmation receipt or
automatic fallback to another acceptance path. Raw SQL, identifiers and
migration details are not returned. Unrelated persistence/permission/trigger
failures retain their normal error handling instead of being mislabeled.

Nineteen database-backed request tests passed. The added migration test
temporarily renames only the suite's private fixture table, verifies 503 on
all four read/write operations, verifies no native status/event changes,
restores the table in teardown and confirms reads recover. It does not alter
shared development or production tables. Additional staff checks deny reads
and publication to an administrator outside the employer scope and to
unassigned hiring managers/interviewers, with a positive employer-admin case.
Three error-classification unit tests and seven frontend helper tests passed;
both application typechecks passed. The existing full browser journey remains
the UI evidence; this small message-handling change did not rerun that journey.

## Candidate confirmation: real PostgreSQL application-boundary evidence

### Instant-specific timezone labels

Candidate offered-time choices and expiry labels, staff proposal/expiry labels,
and the staff view of currently published alternatives now include the numeric
GMT/UTC offset for the actual proposed instant. The coordinator also displays
that per-instant offset in its desktop and mobile time blocks, and native
schedule cards retain the exact time/offset after candidate confirmation. It does not infer
the proposed date's offset from the browser's current date.

Currently published alternatives are explicitly separate from unsaved local
input changes. Nonzero seconds and milliseconds remain visible in full
offered-time labels rather than rounding two different choices to one label.
Stored and submitted instants, native revisions, availability checks and
publication/confirmation behavior are unchanged.

Twelve focused time-formatting/offered-time tests passed in both the default
timezone and America/New_York. Coverage includes New York's repeated 1:30 AM
with two distinct offsets, spring-forward clock changes, India's half-hour
offset and local-date rollover, sub-minute distinctions, invalid input,
and preservation of saved DST-fold anchors. Frontend typechecking passed;
scoped lint had no errors (existing coordinator/ref-cleanup warnings remain).

A synthetic, intercepted browser pass in America/New_York verified that both
1:30 AM options show their different offsets at 390px without overflow. Choosing
GMT-05:00 submitted exactly 06:30Z rather than the earlier 05:30Z instant, and
the matching receipt refreshed the confirmed native card. That pass found the
card's old date-only/clock formatting; the card was subsequently switched to
the same tested instant formatter and checked by frontend typechecking. No
second browser pass was run for that direct formatter substitution. No real
database, provider, email or invitation action occurred.

### Recruiter status and freshness display

The coordinator uses actor-neutral native status labels, including “Time
confirmed in Lexy,” and qualifies the confirmed count as “Confirmed in Lexy.”
It does not infer candidate action, Outlook reservation or invitation delivery
from that shared status. A visible note explains the external-calendar boundary.

The list refreshes every 30 seconds while visible, on mount and on window focus.
There is also a manual refresh action, loading feedback and a “Last checked”
timestamp representing query freshness rather than the schedule modification
time. Failed refreshes retain the existing explicit error/retry behavior and
do not display old counts as current successes. Header actions can wrap on narrow
screens. Mobile rows now show start time and duration; previously the desktop
time block was hidden without an equivalent mobile display. The page names the
browser timezone used for display.

Eight focused status/response tests passed, as did frontend typechecking.
The three new status tests are included in the assisted baseline's existing
lightweight helper group. No API, database, calendar-provider or invitation
behavior changed.

A synthetic, intercepted browser pass verified desktop native status/count
updates after manual refresh, sustained GET-failure handling without stale
success counts, and recovery through Reload schedule. At 320px and 390px,
header actions wrapped and both schedule rows showed start time plus duration
without horizontal overflow. The visible calendar/invitation disclaimer was
verified. All APIs were intercepted; no live calendar, email, invitation or
database operation occurred. The interval/focus settings were source-checked,
not claimed as an observed full-interval browser test.

Eleven tests mount the real confirmation router over local HTTP, use signed
candidate sessions resolved against actual fixture users, and operate on real
PostgreSQL rows in a uniquely owned private schema. They now use the normal
request middleware and ALS-aware database proxy, clone the development policy
predicates, and enable forced RLS on the private policy-bearing tables.

Verified:

- Ordinary candidate requests run as `lexy_app`; their normal request
  connection still cannot read another tenant's jobs.
- Candidate identities cannot call the Outlook free/busy or schedule-event
  read/write routes, including when a signed test token claims recruiter,
  hiring-manager or platform-admin roles. All 24 attempts receive 403 from
  the real stored-role staff gate; an anonymous availability request gets 401.
  The egress guard confirms no provider HTTP calls occurred.
- The candidate-owned native schedule loader returns cross-tenant proposals
  without leaking another candidate's schedules or private staff feedback.
- A candidate whose portal identity is in a third tenant can confirm a schedule
  stored under either their application's agency tenant or its job's employer
  tenant. One native update and one event are committed.
- Another candidate, a staff identity claiming a candidate token role, and an
  unrelated schedule tenant cannot write.
- Two concurrent confirmations produce exactly one successful transition and
  one durable event; the other request receives a conflict.
- Cancelling an opened proposal removes it from candidate reads and rejects
  its old confirmation with 409, without reopening it or recording acceptance.
- Changing a proposed time or duration invalidates the previously displayed
  version. Only the refreshed proposal can be confirmed with the new details.
- Reassigning a proposal removes the former candidate's read access and makes
  their old confirmation return 404. The new owner can read the proposal.
- A fixture trigger rejecting event insertion rolls back the native status
  change in the same transaction.
- A staff edit holding a real row lock is preserved. Once it commits, the
  blocked candidate compare-and-set fails instead of overwriting it.

The runner requires `TEST_DEVELOPMENT_DATABASE_FINGERPRINT` and verifies it
before creating any schema. Obtain that non-secret, short-lived fingerprint
through the explicit development database tool using the same query declared
in the test. The fingerprint combines database identity and the server's
current start time, not credentials or connector transport addresses.
Run `pnpm --filter @workspace/api-server run test:candidate-time-postgres`
with that verified value supplied only for the invocation. Missing or
mismatched fingerprints fail before DDL. No fingerprint is committed here.
Both safety failures were exercised: an invocation without a fingerprint and
one with a valid-shaped but incorrect fingerprint were rejected before fixture
creation. API typecheck, scoped lint and formatting also passed.

All HTTP integrations are egress-blocked except the test's own local server.
The owned schema is dropped on teardown. The test suite is separate from the
default baseline because it must never infer a development target from an
arbitrary configured app connection.

The upgraded suite reproduced a false 404 before the fix: portal-tenant RLS
hid an otherwise candidate-owned employer/agency schedule. Native listing and
confirmation now deliberately use the administrative connection behind
explicit candidate-owned application joins. Confirmation repeats ownership,
tenant relationships, erasure and job-approval checks at the atomic write.
Global RLS policies, allowed tenant scope and commercial controls are unchanged.

These are development-policy/request-role and transaction tests. Production
policies, production triggers, external calendar reservation, email delivery
and real candidate login acceptance remain separate, unverified items.

The latest request-context/PostgreSQL pass passed all eleven tests, including
the cancellation, changed-time and reassignment checks. Scoped test lint,
formatting and diff whitespace checks also passed; this test-only extension
required no runtime restart or production change.

After the original runtime fix, all eight then-current request-context/PostgreSQL
tests and all six focused confirmation regressions passed. The API's managed restart completed its
typecheck, build and security guards and is serving requests. Scoped lint had
no errors (existing warnings remain in the large career-profile route);
new/fixture file formatting and the diff whitespace check passed. An anonymous
portal capture correctly showed sign-in; authenticated data behavior was
verified by the request-context tests, not that screenshot.

## Candidate acceptance of one proposed native time

Candidates can now confirm an upcoming, pending human-interview proposal from
**My Interviews**. This is deliberately narrower than multi-slot self-booking:
it accepts the one recruiter-proposed time already stored in Lexy. It does not
reserve Outlook availability, create a meeting or deliver an invitation.

The write resolves the canonical active candidate identity, authorizes the
schedule through that candidate's application, and preserves the existing
application-tenant OR job-tenant relationship. It rejects changed proposals,
past/closed times, AI interview rows and work orders awaiting approval.
The atomic update repeats ownership/approval and full staff snapshot checks.
Only native status changes; a candidate action event is saved in the same
transaction. Candidate-visible revisions exclude withheld reviewer feedback,
while the server still protects the complete saved row against concurrent edits.

The portal reviews an immutable displayed proposal, prevents double submissions,
rejects malformed success receipts and preserves errors for explicit reload.
It refetches status on success and no longer links human schedule IDs to an AI
interview room. AI session join links and private mock/baseline results remain
separate.

Verification: six egress-guarded controller/SQL-boundary checks and one frontend
receipt check passed. API/frontend typechecks, both builds and API build guards
passed; scoped lint and new-file formatting passed. The controller fixtures do
not prove physical PostgreSQL isolation or a real candidate-session login.
One synthetic authenticated browser pass intercepted every API request:
valid confirmation sent the reviewed revision once, refetched confirmed status
and showed native-only success copy. Delayed responses blocked duplicate
submissions. A 409 and malformed 200 both retained the dialog without success or
automatic retry. Reload control presence was verified, not its click flow.
The anonymous preview correctly rendered sign-in. No real candidate schedule,
calendar event or invitation was changed during verification.

No database migration is required. Candidate choice among multiple approved
times, shareable booking links, panel availability and external reservation/
invitation delivery remain separate unfinished scheduling work.

## Missing personal-hold cancellation recovery

After a failed/uncertain attempt to delete a private Outlook hold and cancel
its native schedule, a fresh calendar read can show no linked hold while the
Lexy schedule is still open. The staff dialog now offers **Cancel Lexy
schedule only** alongside **Add private hold** in that state. This is an
explicitly confirmed human action; it is not an automatic deletion or a
candidate invitation. The confirmation says unlinked Outlook meetings are
untouched and must be checked separately.

The backend already permits this scoped cancellation with no linked event.
It returns `nativeChanged: true` and `remoteChanged: false` when the native
update succeeds. The UI now bases its toast on the returned receipt instead
of claiming it deleted a calendar hold. A stale or unverifiable schedule
still disables both actions; completed/cancelled schedules do not offer the
no-hold cancellation shortcut. Existing guest-meeting and read-failure
protections remain.

Focused egress-guarded checks passed: 19 backend calendar operation/controller
checks and four frontend calendar receipt/action checks. Frontend typecheck,
scoped lint and formatting passed. One isolated browser pass intercepted all
API traffic. With a synthetic matching schedule revision it showed both
actions and sent one `cancel` POST with the reviewed version; the mocked
native-only receipt displayed "no linked hold was deleted." A changed
revision disabled both actions and caused no additional POST. This does not
prove a live Microsoft read, real database cancellation, or invitation
delivery. No real Graph call or candidate email was made.

## Outlook personal-hold stale-schedule protection

The signed-in staff calendar controls now hold the exact schedule snapshot
displayed when the dialog opened. The calendar read includes the native
schedule's content revision. Changed interviewer, notes, status, duration or
other editable fields block every calendar action even when the scheduled time
has not changed. Current Lexy controls submit both the timestamp and revision;
pre-existing callers without a revision retain the older timestamp-only
preflight, not the stronger guarantee.

The API rechecks the revision before resolving the Outlook connection or
calling Graph. Pull/cancel native updates additionally use the complete
atomic native snapshot predicate. A provider change followed by a lost native
race is reported as reconciliation required, not success. This is not an
atomic transaction spanning Microsoft and Lexy; uncertain responses still
require checking both systems before retrying.

The dialog refuses missing/malformed read revisions and invalid event/action
receipts. A stale read retains the reviewed snapshot, disables actions, and
offers close-and-reload. An uncertain response leaves the dialog open and
requires an explicit fresh event read before any retry. Pulling a cancelled
personal event displays cancellation rather than claiming a timing refresh.
No attendee was added to personal holds, and no candidate invitation was sent.

Verification: 36 backend operation/native-scheduling checks, four current
Outlook route-controller checks, and ten frontend calendar/slot checks passed.
The backend route-controller fixture executes the current handler and compares
generated SQL with isolated fake handles; it does not prove physical PostgreSQL
isolation or a real Graph response. Frontend/API typechecks, builds/guards,
targeted lint and formatting passed. One isolated browser pass intercepted
all API traffic: the dialog issued GET without POST on open; create sent the
displayed content revision and received a mock success; a same-time, changed
revision disabled create with a reload notice; and a mock HTTP 409 retained
the dialog and prevented immediate retry. The browser fixtures prove UI
request/response handling only, not live calendar availability or delivery.
Real Outlook consent and writes require the owning staff member's acceptance.

## Candidate-picker read reliability follow-on

The native create dialog now validates the application array before rendering
or selecting rows. Malformed/duplicate identifiers and non-text display fields
fail explicitly. Null candidate/job joins remain representable but are not
selectable. A failed read shows a reload control, not an empty-list claim.
Existing draft fields remain intact; a selected application absent from the
latest verified list cannot be saved. The mutation checks this condition too,
and list requests support cancellation through the query AbortSignal.

Verification: three new boundary checks plus twelve existing native
schedule parsing/rescheduling checks passed (15 total). Frontend typecheck and
scoped ESLint passed with the pre-existing unused Video import warning.
The anonymous app screenshot rendered sign-in; this is not an authenticated
picker browser acceptance claim. No real schedule, invitation, calendar event
or provider request was created by these checks.

Preview startup also exposed duplicate Vite/API listeners. Verified old
listeners were stopped and the existing managed services restarted on their
assigned ports; no artifact routing or port allocation was changed.
This is development-runtime recovery, not a production deployment.

The unrelated startup-wide offer browser run stopped at a fixture navigation
timeout (11 scenarios passed; remaining scenarios were not verified), and a
duplicate assisted-baseline invocation exited because another run held its
lock. Neither is being reported as a passing full regression gate.

## Completed in this batch

- Native schedule list/create/update require an active staff account, with
  requisition/data scope rather than tenant membership alone.
- Recruiters are restricted to assigned requisitions, hiring managers to their
  assigned work orders, and interviewers to explicitly assigned schedules.
- Schedule/application child tenancy must agree. Application tenancy can
  legitimately differ from job tenancy; authorization follows the job.
- Normal reads and creation exclude erased/do-not-contact candidates. An
  authorized cancellation can clean up a suppressed candidate's existing
  schedule without reopening interview execution.
- Unapproved work orders cannot create or reactivate/reschedule interviews,
  including through a platform-admin account. Cancellation remains available.
- Interviewer assignment must resolve to active authorized staff. Interviewers
  cannot use the route to assign another person.
- Dates, durations, statuses, types and feedback ratings are validated; native
  identifiers and ownership cannot be remapped through the update body.
- Closed schedules cannot be reopened. Conditional updates detect intervening
  timing/status/duration changes. Client-held content revisions now cover all
  editable schedule fields; see the conditional-edit follow-on below.
  Keyed create requests now have duplicate-save protection; see the follow-on
  below for its boundaries.
- The coordinator suggests times from the signed-in person's Outlook busy
  periods, working hours, duration, buffer and minimum notice.
- Missing/malformed/failed calendar results remain unknown, never free.
- Selecting a suggestion opens a prefilled draft without a write. Saving
  rechecks availability; conflict retains the draft and prevents the save.
- Manual drafts reopen with blank candidate/date/time. Pending saves cannot be
  dismissed through the dialog close control.
- Local dates and offsets are preserved, including a selected slot in the
  repeated daylight-saving hour.
- No suggestion or native save sends invitations or reserves an Outlook hold.
  The success message makes that separation explicit.

## Verification and limits

- 42 backend checks passed: schedule validation, current-controller HTTP and
  SQL-shape checks, plus existing calendar core/action regressions.
- Six slot-calculation tests passed in both Asia/Kolkata and America/New_York.
- API, library and frontend typechecks passed.
- API managed build/security gates and frontend production build passed.
  Existing build/lint warnings remain; this is not a zero-warning claim.
- OpenAPI contracts were updated and generated types regenerated.
- Focused tests were added to the existing assisted-baseline list. The full
  baseline was not rerun for this batch.
- Browser checks used intercepted authentication, application, schedule and
  Outlook responses with synthetic data. They verified prefill, no write on
  selection, fresh recheck before save, conflict retention, failure states,
  reset behavior and the explicit no-invitation/no-hold success message.
- Mobile controls fit at 390px. A reported drawer overflow was not reproducible
  after the responsive transition settled; the settled drawer was an overlay
  and no DOM element extended beyond the viewport. No navigation change was
  made based on the transient measurement.

The backend controller test executes the current source with fake database
handles and checks generated SQL predicates. It is not a PostgreSQL/RLS or
live provider acceptance test. The browser pass is not live Outlook acceptance.
There was no candidate invitation, offer, calendar-provider write, production
deployment or schema migration for this work. Restarting the existing API did
emit its pre-existing dormant-billing sentinel admin notification; billing
configuration and the sentinel were not changed.

## Still unfinished, not merely awaiting deployment

1. Public booking from expiring candidate-bound links and controlled provider
   invitations/resource reservation. The authenticated native multi-time
   choice is now implemented as described above; it does not complete these
   external booking/delivery guarantees.
2. Common availability across an explicitly consenting interviewer panel is
   now implemented locally above. Persisting a chosen panel, reserving resources
   or sending panel invitations is not included in that finder.
3. Connected external ATS synchronization; local mapping/export is not sync.

The first two have separate follow-up descriptions. None is represented as
complete by the personal calendar slot finder.

## Native save recovery follow-on

- An opened coordinator draft keeps one UUID across explicit save retries.
  The backend derives its schedule identity from that UUID and the authenticated
  creator, using the existing primary key as the concurrent-insert arbiter.
- The read-only recovery endpoint reapplies active staff, current job/data scope,
  child tenancy, interviewer assignment and candidate compliance. A UUID alone
  grants no access. The caller cannot recover another creator's request.
- Matching retries return the existing schedule with an explicit replay marker.
  Changed current details return a conflict rather than creating or updating
  another schedule. Cancelled/completed or past schedules are only read back,
  never reopened by replay.
- After an uncertain response, the browser checks the saved receipt before
  attempting another availability read or POST. Unknown or malformed receipts
  preserve the draft; they do not mean “missing.” If recovery finds the prior
  save after the user edited the draft, those edits are not silently discarded
  or applied.
- Fresh approval, ownership, interviewer and future-time checks still apply to
  actual creation. Reading an existing receipt does not execute an interview,
  create an Outlook hold, send an invitation or relax an approval gate.
- Legacy API callers may omit the operation UUID and retain their previous
  behavior; they do not get keyed replay protection. Opening a new draft is a
  new operation, not recovery of a previously closed browser draft. Receipts
  are not retained separately after the underlying schedule is erased.
- No schema migration, credential, model/provider or billing change was needed.

Follow-on automated verification: 19 backend HTTP/input/key-identity checks and
13 frontend save/slot logic checks passed; library, API and frontend typechecks,
API build/security gates and the frontend production build passed. Backend
concurrency tests use a primary-key-aware fake database, not PostgreSQL.

The focused browser pass also succeeded with intercepted synthetic APIs:
an initial POST 502 retained the draft; an existing receipt was recovered before
any new availability read and without another POST; a recovery 503 retained the
draft without posting; and a recovery 404 triggered fresh availability followed
by a POST with the same UUID. Recovery and new-save messages were distinct.
The edited-draft case was covered by logic tests, not that browser pass.

## Conditional edits and human-feedback follow-on

- Native list/create/recovery/update replies now include a content revision.
  Updated coordinator confirm/cancel actions and the human feedback form send
  the revision they actually displayed. A stale revision is a conflict, not an
  overwrite.
- The final UPDATE compares the complete editable snapshot, including nullable
  interviewer, location, notes and feedback fields. A write occurring between
  the read and UPDATE also conflicts. Revision metadata is never stored as an
  editable database column.
- The legacy human-feedback endpoint now shares the active staff, job/data
  scope, child-tenancy, compliance and assigned-interviewer gates of native
  schedule updates. Missing/foreign records remain indistinguishable.
- Human interviewers read native schedules rather than AI interview sessions.
  The client uses exact interviewer IDs, never matching names, parses the raw
  HTTP response explicitly, polls for freshness and shows load failures instead
  of pretending the queue is empty.
- A feedback conflict preserves rating and notes. The user can read the latest
  saved feedback and explicitly keep their draft against that displayed
  revision; this action itself does not save. Another intervening write still
  conflicts. Errors and invalid save replies do not close the form or claim
  success. A pre-save poll cannot roll back a locally confirmed write.
- Version tokens are content hashes, not monotonically increasing audit
  counters or authorization credentials. Returning to identical content can
  return the same token. Legacy API callers omitting expectedVersion retain
  their old stale-draft behavior, although read-to-write races are guarded.
- No provider/calendar write, invitation, AI assessment change or schema
  migration is involved.

Automated verification for this follow-on: 25 backend controller/input/revision
checks and 17 frontend parsing/save/slot checks passed. Backend tests use fake
database handles and verify SQL predicates; this is not a PostgreSQL/RLS proof.

The focused browser pass used intercepted synthetic requests. It confirmed
exact interviewer-ID filtering, native schedule reads, a completed interview's
409 feedback conflict with draft retention, read-only latest-detail review,
deliberate retry with the reviewed revision, authoritative saved feedback on the
card, and 403 save failure without false success or draft loss. No real users,
database writes, mail or provider calls were part of that pass. The initial
future/pending fixture could not open feedback by design; the completion gate
was preserved and the remaining checks used a completed past interview.

## Staff rescheduling UI follow-on

The coordinator now has a native rescheduling dialog for pending, scheduled,
confirmed and rescheduled interviews. Completed/cancelled schedules remain
closed. Staff can change date, time and duration without changing interviewer
assignment, location, notes or feedback. The dialog identifies the browser's
time zone and explicitly says that availability is unchecked, existing Outlook
holds stay at their old time, and no candidate invitation/calendar update is
sent.

- Every update sends the displayed revision and consumes a validated saved
  record. The dialog does not claim success if the returned application,
  status, time or duration does not match the request.
- Conflicts and uncertain responses preserve the draft and require a read
  before retry. Reading and adopting a newer revision do not send a write.
  Closed schedules found during review cannot be retried.
- If a lost reply is followed by a saved schedule already matching the draft,
  the user can explicitly use that saved record without another PUT. This is
  recovery of native timing, not attribution of who changed it or proof of an
  external booking.
- Date/time rebasing retains the original exact instant anchor, so identical
  local fields cannot silently switch DST-fold offsets. Duration-only changes
  also preserve original seconds/milliseconds.
- Successful updates patch the list before refetching; older polls are aborted
  before installing the saved record. New openings initialize from the saved
  data. Rescheduled interviews can be confirmed/cancelled, including interviews
  that were previously confirmed.
- Native list parsing rejects malformed display data. List failures show an
  explicit reload/error state and unknown counts, not a false empty schedule.

The 25 frontend checks cover input/status/revision limits, unchanged and past
times, DST gaps/folds, exact-time preservation, saved-timing recognition and
native read/save parsing, alongside the existing create-recovery and calendar
slot checks. Type checking and the production frontend build passed. Backend
authorization/update gates and database schema were not changed by this UI
follow-on.

A single intercepted browser pass verified the confirmed-to-rescheduled
journey, 409 draft retention, explicit version review/retry, authoritative
receipt rendering, reopen/reload values, pending counts, lost-reply recovery
without a second PUT, completed-row action suppression and the list's 503
error/unknown-count state. At 390px there was no horizontal page overflow.
The browser used synthetic users and records only; it did not test actual
database persistence, permissions or Microsoft operations. A missing accessible
dialog description found by that pass was added afterwards and checked by
type/lint validation; no flow behavior changed.

## Team/live acceptance remains separate

Production deployment/database-target checks, Microsoft calendar authorization,
live AWS callbacks/private-file operations and genuine Linx acceptance still
need the relevant environment/access/people. Invoice reconciliation remains
deferred and must not restrict the complimentary internal pilot.
