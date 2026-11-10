# Staff-reviewed Google interview invitations

## What is available

The coordinator's confirmed, non-AI interview controls include **Google
invitation + Meet**. Nothing is sent on mount, dialog open, review, refresh or
an AI/background action. Staff must review the candidate email, organizer,
role, exact instant and duration, acknowledge Google may email the guest, and
press the send button.

Requirements:

- Active supported staff with current job/schedule visibility and assignment.
- An approved job, compliant contactable candidate, future confirmed non-AI
  interview and a valid contact email different from the organizer.
- The organizer's own verified Google account and a fresh explicit optional
  owned-event write grant. The project connector is never used.
- Current personal working hours and a fresh Google availability check.
- Google Meet supported on the account's primary calendar.
- No previous invitation attempt for this schedule, including an Outlook one.

This first Google path is **candidate and organizer only**. Saved panels are
rejected rather than silently dropped or authorized through Outlook consent.

## Approval, concurrency and recovery

Review produces a ten-minute HMAC proof bound to the staff/employer identity,
native schedule revision, candidate/application, exact recipient, role/title,
Google subject/account and connection revision. A fresh read may rotate the
proof: the UI compares immutable details and submits the original reviewed
proof while it is valid. Focus, identity, tenant, booking changes and failures
clear approval. Expiring reviews must be refreshed before claiming a send.

The existing private invitation-attempt table and its schedule primary key
provide one shared Google/Outlook claim. The claim is committed before any
Google event mutation. Outlook's common attempt reader refuses Google claims,
including panel sends and guest-meeting changes.

Before mutation, the service reacquires native parent/privacy locks, verifies
active staff and the exact connection under a row lock, and checks permission,
hours, approval and availability again. Provider requests are bounded and
never retried automatically.

Google receives one private primary-calendar event, one candidate attendee,
hidden guest roster, disabled guest invitations/modification, and a new Meet
creation request. Event ID and conference request ID derive from the durable
attempt. No private evaluation, resume, compensation or internal notes are
sent.

The returned event must match the exact ID, organizer, attendee, interval,
title, private flags and attempt binding. Only a verified canonical
`https://meet.google.com/abc-defg-hij` link may be exposed to staff. Meet
creation can remain pending or fail after Google accepts the event.

A failed/lost response leaves the committed claim intact. The UI becomes
read-only and the backend refuses a second send regardless of provider.
Explicit status refresh reads the original event by deterministic ID; it never
lists calendars, inserts a replacement, resends or patches an event. Failed
recovery rechecks current staff/candidate visibility before returning details.

**Google acceptance is not email delivery, guest RSVP, attendance, hiring or a
guaranteed reservation.** There is no cross-system exactly-once claim.

## Configuration and rollout

See [staff OAuth setup](google-staff-calendar-setup.md). No additional secrets
are needed beyond the dedicated Google OAuth settings already documented.
Enable/configure the optional owned-event scope in Google's consent screen,
then have each organizer explicitly reconnect with invitation permission.

Migration `0088_google_interview_invitations.sql` adds two false-by-default
consent flags and two provider/receipt columns. Existing invitation rows default
to Outlook. It retains forced RLS, no request-role/public grants, the existing
candidate erasure barrier, and the shared send-attempt primary key. Complete
consent and provider/receipt checks are enforced in SQL.

Development rollout and private rollback checks passed. Production rollout was
not performed; independently identify the production target and apply reviewed
DDL before publishing code that requires these columns.

## Intentional boundaries and next work

- Native edits/cancellations **do not automatically update the Google event**.
  The separately reviewed [Google operation controls](google-interview-operations.md)
  now handle time changes and cancellation of the original event. Never
  delete/reset the original send claim to work around an uncertain outcome.
- Google Meet is present in Google's invitation and the staff receipt. This
  phase does not rewrite native location/link fields or add a candidate-portal
  fallback. A future candidate appointment read may expose only the verified,
  current, matching accepted Meet URL—not private receipt/account metadata.
- No Google panel-sharing consent, panel invitation, RSVP sync, background
  reconciliation, recurring events or external ATS writes are implemented here.

## External live acceptance still pending

After OAuth and approved production schema setup, use isolated consenting
internal accounts to verify readonly-to-write consent, busy/free preflight,
one reviewed guest event, asynchronous Meet, provider/account failure recovery,
cross-provider blocking and no duplicate email. The automated suites mock
Google; no real staff grant, guest event or email was created by this work.
