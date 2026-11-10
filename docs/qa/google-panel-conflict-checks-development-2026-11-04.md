# Google panel reschedule availability — development

The prior organizer-only reschedule limitation is closed for currently verified
Google panels. Staff still approve the exact recipients, previous/target times
and original event; no guest-list edits or replacement invitations are added.

## Change boundary

- All current panel grants, sharing consents, staff/job access and account
  revisions are revalidated under the existing ordered locks.
- Organizer and member working hours are checked with the saved panel buffer.
  Missing working-hours policies retain the existing no-invented-default rule;
  an explicitly empty policy blocks availability.
- Credentials for the organizer and every panel member are refreshed and any
  rotated refresh tokens are committed before acquiring panel/grant locks.
  A private, short-lived preparation must still match the fresh booking, panel,
  configuration and hours evidence. It cannot fall back to organizer-only checks.
- Busy reads inspect only each owned primary calendar's bounded target interval.
  Saved buffers apply. The original organizer event can be excluded by its
  verified ID. A member copy additionally needs the observed original iCalendar
  identity, original organizer/time, exact guest list and that member's self
  attendee evidence. At most one such member copy is excluded. A duplicate,
  different event or all-day/unknown busy interval is not subtracted.
- Incomplete, paginated, unauthorized, malformed or busy results stop the update.
  No event contents are returned to staff or candidates or included in errors.
- All-calendar checks run before the durable intent and again before PATCH.
  An early failure leaves no claim. A later failure preserves the uncertain
  intent for review; it does not resend, replace or automatically retry a write.
- Cancellation intentionally does not depend on availability.
- Staff-facing copy now explains the full-panel check and that an availability
  check is not a reservation. Concurrent external edits can still race a check.

## Evidence

- **73 focused tests passed:** operation service, provider transport, invitations,
  candidate Join, recording authority/core and operation HTTP authorization.
  New cases cover full-panel checks in both phases, early/late member busy
  results, absent preparation, cancellation independence, exact member-copy
  exclusion and wrong UID/organizer/time/self/guest/duplicate/paging/error data.
- **98 combined development checks passed** in the fingerprint-guarded fixture.
  The new groups run the actual private store, scope checks, locks, grant CAS
  and hours queries with fake provider transport. They verify revoked consent,
  replaced grants, member working hours, busy data, and credential rotations
  surviving both a later transaction rollback and another member's failure.
  All synthetic records and changed fixture properties are restored/cleaned.
- API and web TypeScript, changed-source ESLint, the 11 release-manifest tests,
  diff checks and the managed API build guards passed.
- API/web workflows restarted; `/api/healthz` reported healthy DB access.
  Login-page screenshot is only startup sanity, not signed-in acceptance.

There is no new migration, contract expansion, AI change, production access or
live Google mutation test. The pre-existing billing sentinel warning is unchanged
and emits its normal admin alert on startup. The full assisted-baseline workflow
remains failed; these targeted checks do not relabel it as passed.

**Still separate:** controlled live Google/LINX acceptance, and reconciliation
of edits/deletions made directly in Google before candidate Join publication.
