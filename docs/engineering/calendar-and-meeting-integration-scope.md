# Calendar and meeting integration scope

Approved sequence: 2026-10-24.

## Objective

Provide one reusable scheduling workflow for native Lexy and future
ATS-connected recruiting. Do not build another hiring system or delay the
first ATS connector for optional meeting features.

This document records scope and acceptance boundaries. It does not claim new
Google/Teams functionality is implemented, authorize provider writes, or
establish production readiness.

## Order and current evidence

| Order | Work | Current position |
| --- | --- | --- |
| 1 | Outlook live acceptance | Native calendar controls, candidate booking, reviewed invitation/change workflows and local regression coverage exist. Actual target rollout and authorized mailbox acceptance remain unverified. Follow `docs/ops/scheduling-release-checklist.md`. |
| 2 | Google Calendar and Google Meet | Start with connection and private availability, then approved event/meeting creation. No Google provider implementation was found in the current API. A Google Calendar API integration is available for authorization; availability in the catalog is not a connected or verified account. |
| 3 | Microsoft Teams meeting links | No Teams meeting-link creation implementation was found in the current API. Add the account-capability check and approved link creation without turning existing personal holds into guest meetings. |
| 4 | First ATS connector | Preserve native hiring and employer-owned offers. Default to Greenhouse unless a participating customer's actual ATS changes the choice. |
| Later | Zoom, Calendly and broader ATS coverage | Customer-driven additions, not prerequisites for the first ATS connector. |

The first Google delivery is the deliberately narrower admin-only read pilot,
not completion of staff calendar access. Live read verification and remaining
authorization work are recorded in
`docs/qa/google-calendar-readonly-pilot-2026-10-24.md`.

The subsequent staff-owned authorization/private-interval implementation is
recorded in `docs/qa/google-staff-calendar-2026-10-24.md`. Dedicated Google OAuth
application setup, production schema rollout and real staff acceptance remain
external prerequisites. Panel sharing and reviewed Google invitation/Meet
creation are not enabled by that read-only staff grant.

The separate optional write-consent and staff-reviewed candidate-only
invitation/Meet path is now implemented. Setup, isolated live acceptance and
approved production schema rollout remain pending. See
`docs/engineering/google-interview-invitations.md` for exact boundaries;
Google panel sharing, subsequent event changes and ATS writes are not implied.

Separately reviewed time changes and cancellation of the original Google event
are now implemented; see `docs/engineering/google-interview-operations.md`.
Candidate-appointment Meet projection and external live acceptance remain
separate work.

Outlook acceptance needs authorized staff participation. Keep it pending rather
than simulating success or blocking independent Google implementation.

## First Google implementation unit: connection and private availability

1. Verify the integration's supported authentication and account-binding model
   before choosing transport. An operator/test connection alone does not
   establish customer-specific production authorization.
2. Bind each usable connection to the authenticated staff member, employer
   scope and verified provider account. Never let callers supply another
   person's identity or a shared global mailbox as authorization.
3. Expose an honest connection/capability status with a disconnect/revocation
   path. An installed SDK, saved configuration or successful OAuth redirect
   alone must not be labelled usable calendar access.
4. Read only the authorized calendar information needed to check bounded
   interview availability. Do not expose event titles, descriptions, attendee
   lists or calendar contents to candidates.
5. Preserve current working-hour preferences and explicit sharing consent.
   OAuth permission does not authorize panel sharing; reconnecting a different
   mailbox invalidates the old account-bound sharing decision.
6. Handle expired/revoked permissions and partial reads explicitly. Failed or
   unknown availability is not an available time.
7. Keep the existing candidate experience based on deliberately published
   offered slots, never a general calendar or date-range free/busy browser.

Deliver this unit with the staff UI and real API behavior together, plus
isolated contract/authorization tests. Mocked tests remain local evidence.

## Second Google unit: approved invitations and Meet links

- Review the organizer, candidate, any explicitly authorized panel, exact time,
  duration, time zone and meeting choice before a provider write.
- Bind final approval to that immutable snapshot and current account,
  permissions and availability. Changed details require fresh review.
- Persist the invitation intent before any provider mutation. Bind one
  scheduling/invitation owner to the interview across providers: Google and
  Outlook must not independently invite the same candidate.
- Use supported Calendar conference creation for Google Meet when the account
  allows it. Pending conference creation is not a usable meeting link.
- Do not invent a meeting URL or silently fall back to another provider.
- Preserve distinct native-save, provider-acceptance, delivery and guest-RSVP
  states. A successful event request proves neither delivery nor attendance.
- Reconcile uncertain writes through bounded reads; do not automatically retry
  an invitation that may already have been accepted.
- Keep organizer-controlled changes/cancellations explicit. They must not be a
  side effect of a native schedule edit or candidate time-change request.
- Verify actual guest-address privacy before supporting candidate-facing panel
  invitations. Outlook's privacy behavior is not evidence of Google's behavior.

Calendar authorization and Google Meet creation are separate capabilities from
Gmail access. Gmail is not a prerequisite for this scope.

## Teams scope

Verify the connected Microsoft account's supported meeting providers and
permissions. Reuse the reviewed invitation/receipt boundaries rather than
adding an independent, unguarded meeting-creation button.

Personal hold controls must remain attendee-free and must not silently become
online meetings or send guest updates.

## ATS compatibility requirements

Retain or introduce explicit links between the authorized employer, candidate,
requisition/application, organizer connection and provider event/meeting.
When an external ATS is connected, distinguish its identifiers from Lexy's.

One system owns scheduling for an interview: Lexy or the employer's external
ATS/scheduler. Synchronization must not trigger a second invitation workflow.
The employer ATS remains the hiring record in connected mode; Lexy retains its
native hiring mode for other customers.

## Acceptance and evidence

- Use synthetic requisitions/candidates and authorized staff test accounts.
- Contract tests intercept every provider request and deny unrelated egress.
- Test staff/tenant/account isolation, revoked consent, stale approvals,
  duplicate clicks, lost receipts, failure recovery and candidate privacy.
- Verify staff UI state after reload and account changes.
- Record live connection, actual provider behavior, delivery and recipient
  response separately from mock regression results.
- Run the applicable release gate before rollout and verify the real target
  database if a reviewed schema change is introduced.
- Do not send a real invitation, modify a real calendar or grant sharing on
  another staff member's behalf without the appropriate explicit authority.

## Excluded from this milestone

Automatic meeting attendance, recording, transcription, summaries, Gmail,
Zoom, Calendly, broad ATS coverage, pricing restrictions, changes to stabilized
AI configuration and autonomous offer authority.

## References

- Existing Outlook: `docs/engineering/OUTLOOK_CALENDAR.md`
- Release/live acceptance: `docs/ops/scheduling-release-checklist.md`
- Local evidence: `docs/qa/scheduling-local-readiness-2026-10-22.md`
- Google Calendar conference creation:
  <https://developers.google.com/workspace/calendar/api/guides/create-events#conferencing>
