# Candidate Google panel Join links — development

The existing **Candidate portal → Interviews → Join Google Meet** control now
supports a currently confirmed panel appointment whose original accepted Google
invitation and panel binding remain valid.

## Privacy and authority

- The private store first joins the exact schedule through canonical candidate
  ID and owning portal user, with the existing compliance and application/job
  tenant predicates. A foreign candidate/user receives no appointment.
- Only then does it re-read the saved panel, current staff roles/job access,
  Google account identities/revisions and sharing consents. Checks run under
  the original organizer and the explicit private transaction, never by
  treating the candidate's tenant as permission to read staff calendars.
- The original organizer must still have job access. The actual assigned
  recruiter path is tested, including denial after assignment removal.
- Current panel revision/binding must match the original accepted Google panel
  receipt. Solo, Outlook, orphan and changed panel evidence cannot qualify.
- Candidate output remains exactly five fields: schedule ID, time, duration,
  availability status and safe Meet URL. It contains no panel roster, staff
  emails, calendar events, account grants, approval hashes or private notes.
- The provider-accepted public booking binding ignores staff-only notes and
  feedback. Changed time/duration/contact, uncertain or cancelled changes,
  broken operation history and unsafe URLs remove the link. Joining works
  during the appointment and the existing bounded reconnection grace.

The existing Join control already polls, refetches on focus and checks the exact
current booking again immediately before navigation. No panel-specific UI branch
or broader API contract was needed; the portal renders it for confirmed native
appointments without filtering panels out.

## Verification and limits

- Seventeen focused candidate-projection/route tests passed, including initial
  and accepted-rescheduled panel receipts, private-only serialization,
  self-ownership, changed bindings, cancellation, pending changes and grace.
- The fingerprint-guarded development fixture passed **90** combined HTTP/
  database/privacy/processing groups with mocked provider, storage and AI.
  Added checks execute the real candidate store and panel/consent/grant joins:
  healthy Join, foreign self rejection, private feedback stability, cancellation,
  member account rotation, disabled member, withdrawn consent, restored consent,
  solo-receipt rejection and assigned/unassigned recruiter ownership.
  Synthetic candidate accounts, dates, roles and receipts are restored/cleaned.
- API TypeScript, changed-source ESLint and diff checks passed. The managed API
  restarted and `/api/healthz` reported healthy database access.

No candidate read refreshes tokens, calls Google, sends an invitation or changes
an ATS record. These are stored acceptance checks, not live Google event
verification, delivery or attendance proof. An event changed/deleted directly
in Google still needs a separate reconciliation mechanism.

No SQL migration or AI configuration change was introduced; production was not
touched. Live Google acceptance and signed-in LINX acceptance remain team work.
The unchanged Join UI was not represented as a newly completed signed-in browser
acceptance test, and the full assisted-baseline result was not reclassified.
