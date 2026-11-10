# Google panel availability

Google-only suggestions and explicitly saved native panels sit alongside the
existing Outlook panel workflow. Searching does not save anything. Reviewing a
suggestion and pressing **Save panel and time** stores the roster, time and
buffer in Lexy and marks the appointment pending for reconfirmation. Neither
action reserves calendars, publishes choices, sends invitations or supports a
mixed Google/Outlook panel.

## Permissions and ownership

- `GET/POST /api/google-calendar/panel-consent` manages only the signed-in active
  staff member's sharing permission. Enabling requires explicit acknowledgement
  and the real current connection revision. A client cannot supply an employer,
  another user, calendar identifier or credential.
- `enabled` describes a saved current-revision permission. `canEnable` describes
  current connection health. A saved permission remains withdrawable even when
  configuration/provider access needs attention.
- Consent is separate from Outlook sharing, Google OAuth and invitation consent.
  A reconnect/replacement changes the Google grant revision and cannot inherit an
  old permission.
- Candidate accounts cannot use any of these endpoints. Interviewers can manage
  their own sharing but cannot coordinate searches.
- The panel directory/search first resolves the authorized native interview.
  Members must be active, non-erased, in the relevant employer/agency boundary,
  authorized for that requisition and explicitly sharing their current verified
  staff-owned Google grant. Only their IDs and names enter the directory DTO.
  Project-wide Google integration credentials are never used.

## Reading availability

`GET /api/google-calendar/schedules/:scheduleId/panel-members` returns the
eligible directory and current native staff revision.

`POST /api/google-calendar/schedules/:scheduleId/panel-times` checks one to five
distinct people over a window of up to 25 hours in the next 90 days, using the
native meeting duration and a 0–60-minute buffer. These match the existing
calendar safety bounds, not commercial plan limits.

Preflight validates scope, schedule, every grant and every consent before token
refresh. Rotated refresh credentials are persisted independently of the later
read transaction: rolling a token rotation back after Google accepted it could
lose working access. The calendar read then revalidates all evidence under
ordered locks (users, grants, consents), including withdrawal/regrant during
refresh. Caller/requisition access is checked again before returning.

Only the owned primary calendar identifier and Google free/busy are read.
Incorrect account/window, missing calendars, provider errors, malformed busy
intervals and partial-panel failures never mean “free.” Busy intervals stay
server-side. Suggestions intersect all participants' saved working hours,
including buffers and timezone/DST handling. Missing hours produce no
unrestricted slots. Output includes only interval suggestions, timing/version,
panel count, duration and explicit `calendarReserved:false` /
`invitationSent:false`.

## Staff interface

Settings exposes the separate Google permission. The coordinator exposes a
Google-only search beside the existing Outlook panel feature.

Results are invalidated on identity, role, schedule, input or directory changes,
read failures and expiry. **Review time** opens a panel/time review, not a
time-only draft. Staff must explicitly Save. Candidates continue to see only
separately staff-published offered times, never staff calendars.

## Native panel persistence

`GET/PUT /api/google-calendar/schedules/:scheduleId/panel` reads, saves or
deliberately removes a Google panel. GET and removal do not require working
Google configuration or a healthy directory. Both require current coordinating
staff access and protected native panel storage. An empty removal preserves the
exact current time, uses zero buffer and retains a fresh revision tombstone.

Nonempty saves require the assigned interviewer, current sharing/grants,
working hours and free/busy for every selected person. Credential rotations
commit before grant read locks. Native time/status/revision and the private
roster commit atomically under the native schedule lock and full snapshot CAS.
Two writes from one stale revision cannot both succeed. Save failures roll back
the native change; uncertain replies require reload before retry.

Private JSON members use explicit Google provider, connection revision,
subject hash and consent timestamp bindings. Untagged legacy Outlook rows
remain valid. Mixed or malformed rows fail closed. Staff views return only
provider, member IDs/names and native scheduling fields, not account bindings.
Each provider's controls reject overwriting/removing the other provider's
active roster; switch by explicitly removing with its original controls first.

The shared native reschedule, duration, signed-in candidate confirmation and
public booking guards recheck saved Google bindings and current availability.
Internal candidate checks reuse the already owner-scoped administrative
transaction: they do not widen candidate RLS or read staff schedules through
the candidate's default connection. Discovery/save retain 15 minutes' notice;
confirmation of an already-offered time can recheck while it remains future.

Google panel invitations are not implemented here. Existing single-attendee
Google invitation and candidate Meet publication guards remain conservative
for any native panel revision, including removal tombstones; saving/removing
does not grant new authority to reuse an old external invitation.

## Schema and release

Panel persistence uses the existing private JSONB roster; no additional public
DDL is required beyond the previously documented calendar/panel migrations.
Deploy API and frontend together. No production schema or data was changed by
this implementation.

`lib/db/drizzle/0089_google_panel_consents.sql` introduces a private staff-only
permission table, forced RLS, no request-role policies or privileges, and user
deletion cascading. No existing account is opted in. It was applied only through
the explicitly identified development handle after matching the application's
database fingerprint.

Production must have the matching schema **and** privacy controls. Verify the
actual database target and its documented rollout process; do not assume Publish
applies SQL security changes or migrates an external database. Missing or
overexposed storage returns a private-safe unavailable response, not empty/free.
There is no startup DDL.

Real owned-account OAuth, working-hour configuration and multi-person Google
acceptance remain release checks. Mocked browser/provider checks are not proof
that a customer's account permissions work.
