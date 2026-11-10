# Google panel change controls — development

## Scope

The existing **Update Google** and **Cancel in Google** controls now support a
previously accepted Google panel invitation when the original organizer and
the original saved panel/account/consent binding remain current.

1. Save the new time or cancellation in Lexy first.
2. Open the Google operation control and review the candidate, every panel
   recipient, organizer, current provider time and proposed time/cancellation.
3. Acknowledge the saved native edit and explicitly approve this one external
   change. A fresh read checks the details before the signed approval is sent.
4. Rescheduling conditionally patches the original event's time, not its
   attendee list; cancellation conditionally deletes the original event.
   Both request Google notifications to all guests. Provider acceptance is not
   evidence of email delivery, attendance or a guest response.

No replacement meeting, provider-independent resend, automatic approval or
automatic retry after an uncertain response is added.

## Authority and recovery

- Current saved panel revision/binding must match the immutable Google
  invitation panel receipt. Old solo and Outlook panel evidence cannot qualify.
- The shared store rechecks the current staff/job ownership, panel coordinator,
  member roles/job access, Google identities/revisions and sharing consent.
  Locks and fresh reads protect both durable intent and the provider mutation.
- The signed review includes the current panel binding and provider ETag.
  A changed list in the frontend's fresh read clears human approval; malformed,
  duplicate or candidate/organizer-colliding recipient arrays fail closed.
- Provider observations and PATCH receipts must contain exactly the original
  candidate and panel guest set. The existing `If-Match` ETag, event identity,
  Meet-link and operation-marker checks remain in use.
- A pending/uncertain operation blocks retries. A PATCH is recovered read-only
  only from its matching operation marker and target time. A missing event
  following an uncertain DELETE is not attributable cancellation acceptance.
- Recording import is eligible only after an accepted reschedule and a fresh
  current booking/panel proof. Pending or cancelled operations cannot authorize
  recording import.

## Explicit limits

- The mutation preflight checks the **organizer's** working hours and calendar
  conflicts, excluding only the original event. It does not newly inspect
  every member's calendar. The dialog instructs staff to review panel
  availability before saving the new time; this is not an all-panel conflict
  guarantee or an availability reservation.
  **Follow-on update:** the organizer-only limitation described above is now
  superseded by [full-panel conflict checks](google-panel-conflict-checks-development-2026-11-04.md).
  Every current member and saved buffer/hours are checked before a reschedule.
  This is still not an external availability reservation.
- Changing panel membership, saved account identity or sharing consent does
  not authorize editing the external guest list or creating a replacement.
  Such cases remain unavailable and need a separate reviewed recovery flow.
- Candidate-portal publication of panel Join links is now implemented with
  current private panel verification; see
  [candidate panel Join evidence](candidate-google-panel-join-development-2026-11-04.md).
- Live Google acceptance, operator consent/account setup and LINX acceptance
  still need the team. No production or real provider calls are needed by
  the automated tests here.

## Verification

All **67** targeted service/transport/route/projection tests passed. They cover reviewed panel reschedule/cancellation,
stale and mismatched panel proofs, post-claim changes, exactly one original-event
mutation, strict guest-set verification and unknown-outcome recovery.
Recording-proof regression checks cover accepted, pending and cancelled panel
operations. Candidate-link regression fixtures retain legacy full-content
receipts separately from current candidate-visible booking bindings.

Shared OpenAPI clients were regenerated. No SQL migration, AI-model/provider/
prompt change or commercial restriction was introduced. These checks are not
a claim that the full assisted baseline or production readiness has passed.

API and web TypeScript, changed-source ESLint and diff checks passed. The managed
API restarted and `/api/healthz` returned healthy database status. Its preexisting
Stripe sentinel configuration warning remains; startup sent its normal
administrative alert, unrelated to these fixtures. Billing configuration was
not changed.

One browser pass mounted the actual operation component in the existing
development-only synthetic host because the app redirected to login. Exact
operation requests were mocked; no provider invitations, calendar changes or
test emails were sent. Reschedule and cancellation required both approval
gates, showed candidate/all panel recipients and sent only one precise POST per
approved synthetic operation. A changed panel on pre-send read cleared approval
with zero POSTs. Invalid/duplicate/colliding arrays failed closed; a later 403
removed cached private details. The 402px dialog had no horizontal overflow.
The test host and interceptions were removed. This is component-browser
evidence, not signed-in LINX or live Google acceptance.
