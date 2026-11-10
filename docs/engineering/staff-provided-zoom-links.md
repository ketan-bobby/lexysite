# Staff-provided Zoom interview links

## Scope and trust

This is a usable interim workflow while the built-in Zoom connector fails
authorization with **Invalid client ID**. It is **not** automatic Zoom meeting
creation or a provider-verified meeting receipt.

Staff create the correct meeting in Zoom, open **Staff-provided Zoom** on the
coordinator's human appointment card, enter its participant join link, review
the job/time/duration/link, and explicitly approve publishing it in Lexy.
The appointment must be future, confirmed, approved and compliant. Existing
staff tenant, requisition ownership and assigned-interviewer gates apply.
Nothing creates invitations, emails or Zoom/calendar writes.

## Stale-link staff alerts

The scheduler leader reconciles publications at startup and every minute, in
bounded, rotating keyset pages. Changed appointment evidence, cancellation,
conflicting calendar invitation attempts, invalid links or lost publisher
authority can create a generic **Staff-provided Zoom link needs review** notice
in the existing staff notification inbox. Current publisher/interviewer, lead
and additional recruiters are considered, but each recipient must still be an
active, non-erased, authorized appointment coordinator in the current tenant
and requisition scope. No tenant-wide broadcast or external email is sent.

The notification contains no candidate/job names, times, emails, staff roster,
join URL or passcode. Its action opens Scheduling, where normal current
authorization applies. DNC, erasure, an unapproved work order or a completed
appointment suppresses new notices and retires existing unread alerts.
Private feedback and merely passing the appointment time do not cause spam.

Deduplication binds publication, relevant public evidence and recipient.
Competing scans serialize with native changes and link publication/removal.
Read notices stay read on repeated scans. Successful reapproval/removal marks
earlier alerts read in the same transaction; receipts are retained rather than
deleted. This is not a retention policy for obsolete meeting passcodes.

Candidates see only their own current approved participant link, labelled
**Staff-provided—not API-verified**. No staff identities, credentials, calendars,
private feedback, approval tokens or host/start URLs are returned.

## Approval and persistence

The read/review/publish/remove endpoints are under
`/api/zoom/schedules/:scheduleId/link` and `.../link-review`.
Candidate self-read is
`/api/portal/interview-schedules/:scheduleId/zoom-link`.

- Strict participant URLs: HTTPS `zoom.us` or one single-label subdomain,
  `/j/` followed by 9–11 digits and an optional `pwd` parameter only.
  Personal-room, host/start, host-token, redirect and ambiguous URLs fail closed.
  The server never fetches a user-entered URL.
- A ten-minute approval binds staff identity, exact normalized URL, current
  native version, candidate/appointment evidence and prior publication UUID.
- Native schedule locking serializes publication with edits and existing
  calendar invitation writes. A lost version or publication race returns 409.
- Replacing/removing uses an explicit publication revision. Removal keeps a
  fresh empty tombstone so restoring the same native time/status cannot revive
  an old approval.
- Changed public appointment evidence hides the candidate link until staff
  review again. Private feedback/notes alone do not invalidate the link.
- A calendar invitation receipt, even uncertain, blocks publication and hides
  a formerly published Zoom link. Staff must resolve the provider conflict;
  Lexy does not silently replace a calendar meeting destination.
- Publisher suspension, lost coordinating scope, erasure, changed candidate
  ownership, DNC or an unapproved/cancelled appointment suppress candidate access.
- Uncertain writes require reload. No retry pretends that a lost response means
  nothing was saved.

Removal/rescheduling/cancellation in Lexy does **not** change Zoom. Staff remain
responsible for updating or cancelling that external meeting. Completing the
OAuth host binding, API creation and provider lifecycle remains separate work;
a project-level connector must never authorize every employer/staff host.

## Storage and release

Migration `0090_interview_zoom_links.sql` creates private staff approval storage
with forced RLS, no request-role/public privileges, no policies and a candidate
erasure write barrier. The candidate erasure inventory deletes these records.
Runtime privacy readiness fails closed if storage is missing or exposed.

The migration was applied only to the development database after explicitly
matching its fingerprint with the application test handle. No production
migration or data change was performed. Verify the deployed target and its
established migration/security rollout; do not assume publishing migrates an
external production database. Release API and UI together.

## Verification

Backend checks include URL spoofing/host-token rejection, expiring HMAC
approvals, feedback-independent public evidence and real HTTP/PostgreSQL
save/reload/self/foreign access, concurrent approvals, removal tombstones,
native changes, calendar conflicts, private role denial and late-erasure writes.

The browser harness uses real React components and generated clients with
intercepted HTTP. It covers review/explicit approval, persistence/remount,
removal, draft/auth/version invalidation and candidate safe rendering.
It is not live Zoom acceptance, full signed-in coordinator acceptance,
production permissions verification or a proof that a pasted meeting matches
Zoom's actual time, host or attendees.
