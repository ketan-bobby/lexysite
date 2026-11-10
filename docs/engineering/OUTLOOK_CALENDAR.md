# Outlook Calendar

## Connect

1. Open **Settings → Outlook Calendar** while signed in as a staff member.
2. Choose **Connect Outlook Calendar** (or reconnect) and sign in to the **same Microsoft account** used for Outlook email.
3. Approve the delegated `Calendars.ReadWrite` permission. Microsoft tenant policy may require an administrator to approve it for the existing app registration.

This reuses the existing Outlook email app registration and OAuth callback
(`/api/auth/microsoft-graph/callback`). It does not require a new callback URL,
an application-wide calendar permission, or new Lexy database columns.
Existing email-only connections do not imply calendar consent.
Calendar consent must actually grant `Mail.Send`, `Mail.Read` and
`Calendars.ReadWrite` for Microsoft Graph. A partial grant or a different
Microsoft account is rejected before replacing the stored working connection.

The connection is per user. An administrator's connection does not grant Lexy
access to another interviewer's mailbox. Disconnecting Outlook removes both
email and calendar access; it does **not** delete existing Outlook events.

## Use

Open **Interview Coordinator** at `/coordinator` (`/recruiter/coordinator` is also supported):

- The availability card shows busy intervals from your connected Outlook
  calendar, for the selected day in your browser's time zone. It does not expose
  event subjects, descriptions, or attendees.
- On an existing authorized schedule, choose **Outlook**.
- **Add private hold** creates a private, attendee-free Outlook event.
- **Use Lexy timing** updates that private hold from the native schedule.
- **Use Outlook timing** explicitly pulls the linked event's time and duration
  into the native schedule.
- **Cancel schedule and hold** removes the personal hold and cancels the native
  schedule. A cancelled native schedule can still have its remaining personal
  hold cleaned up; a completed schedule cannot be overwritten as cancelled.

Every write requires a human confirmation. Candidate interview invitations
remain in the existing controlled invitation flow. These holds send **no
candidate or guest invitations**.

Native schedule buttons are explicitly separate: **Cancel in Lexy** does not
delete an Outlook event. Use the Outlook cancellation control when cancelling
both. Native edits and Outlook edits do not propagate automatically.

## Boundaries and recovery

- This is **manual two-way synchronization of personal interview holds**, not
  automatic background calendar synchronization or panel scheduling.
- Guest meetings, recurring events and events owned by someone else are
  deliberately not changed. Manage those in Outlook.
- Availability is checked immediately before creating or moving a hold. It is
  not an atomic reservation across Microsoft and Lexy; another application can
  change a calendar concurrently.
- Provider failures, incomplete pagination and missing permissions never mean
  "free." Errors remain visible and no successful sync is invented.
- Remote updates/deletes require the current Outlook revision. Native pulls and
  cancellations use a compare-and-set against the original native schedule.
- If Microsoft accepts a write but a response is lost, or native timing changes
  concurrently, refresh both views before deciding what to do next. Stable
  creation transaction IDs reduce duplicate retries; this is not an
  exactly-once delivery guarantee.
- The durable link is a tenant-bound, opaque extended property on the Outlook
  event. It is scoped to the connected mailbox, not a subject-line match.
- Work-order visibility, recruiter ownership, interviewer assignment, staff
  status, job approval and candidate contact restrictions remain enforced.
  Calendar failures do not mark an otherwise healthy email connection broken.

## Verification

Run `pnpm --filter @workspace/api-server run test:outlook-calendar`.
These isolated tests cover consent state integrity, scope and ownership rules,
busy-time pagination, private-event safety, action receipts, retries and
concurrent-change recovery without calling Microsoft. SDK/transport substitutions
also cover token refresh, same-account consent, partial grants, permission loss,
throttling, event revisions and malformed or lost provider responses.
Provider exception payloads are not persisted as mailbox errors or exposed in
the wrapper's logs; only normalized failure codes are retained.

Browser API replays verify the UI contract, not real Microsoft consent or live
calendar acceptance. Live acceptance still requires a staff member to grant
calendar access and verify a personal hold in their own connected account.

Shared-slot selection, candidate self-booking, guest invitations and automatic
provider change synchronization remain separate work.
