# Staff-owned Zoom interview meetings

Lexy's native Zoom path uses a staff member's own OAuth authorization. The
project-wide Zoom connector does not establish interview-host ownership.
Staff-provided participant links remain a separate, explicitly unverified path.

## Application setup

Configure a user-level Zoom OAuth application with permission to read the
authorizing user's profile and create, read, update and delete their meetings.
Limit development access to approved test users until live acceptance is complete.

The API expects these configuration names:

| Name | Purpose |
| --- | --- |
| `ZOOM_OAUTH_CLIENT_ID` | Zoom OAuth application client ID |
| `ZOOM_OAUTH_CLIENT_SECRET` | Confidential client credential; add through Secrets |
| `ZOOM_OAUTH_REDIRECT_URI` | Approved HTTPS API origin followed by `/api/zoom-account/callback` |
| `ZOOM_OAUTH_SETTINGS_URL` | Approved HTTPS app origin followed by `/settings/calendar` |

The existing `SESSION_SECRET` is also required for the approval and credential
protection infrastructure. Do not put credentials in URLs, source files or chat.
Without complete, valid configuration the UI explains that setup is required;
it does not try to authorize with a placeholder client ID.

Apply the reviewed additive migration `lib/db/drizzle/0098_staff_zoom_meetings.sql`
to the correct database. It creates private, forced-RLS account and meeting-intent
tables. The development migration does **not** establish production schema readiness.
This project's externally hosted production database needs its own team-managed
schema rollout; no production migration runs at server startup.

## Staff workflow

1. Open **Calendar preferences → Your Zoom account** and confirm that the host
   account being authorized is your own.
2. Authorize in Zoom. The callback requires the same active staff identity and
   short-lived browser-bound state. Refresh credentials are encrypted and never
   returned to the browser.
3. Open an eligible, confirmed non-AI appointment in the coordinator and choose
   **Zoom meeting → Review creation**.
4. Check the exact appointment time, duration and host, then confirm in Zoom.
   A durable local intent is written before the provider call.
5. If staff change the native appointment time, the old candidate link is hidden.
   The original host must review the new time and confirm the Zoom update.
6. Cancellation likewise requires a fresh, explicit review by the original host.
   Removing a manual link or cancelling only the native appointment does not
   itself cancel a Zoom meeting.

Creation does not send an email, create an Outlook/Google invitation, confirm an
RSVP or change a hiring decision. Those remain distinct workflows.

Candidates can read only their own current participant link. A provider-accepted
native meeting is labelled separately from a staff-provided link. Host start URLs,
OAuth credentials and other people's calendar information are never serialized.

## Uncertain outcomes and account changes

A timeout can mean Zoom accepted a request even though Lexy did not receive the
receipt. Pending or uncertain intents suppress candidate publication and block
automatic retries. The host should inspect Zoom; do not create another meeting
or clear the intent by bypassing the application.

The original host can open **Zoom meeting → Recover an uncertain Zoom result**.
For a lost creation receipt, enter the meeting ID found in that same host's Zoom
account. Verification only reads Zoom; it does not resolve the local intent yet.
The review identifies the original action, host, exact time/duration and intended
resolution. Staff must check the evidence and explicitly confirm recovery.

Creation and time-update recovery require Zoom to return the exact operation
reference stored in its agenda, the original host, matching meeting identity,
topic, time and duration. Confirmation re-reads the provider and rejects changed
evidence, expired approval, changed account/appointment or lost authority.
Cancellation recovery requires Zoom's documented missing-meeting response for
the already-saved meeting ID; a generic 404 or permission failure is not proof.
Local resolution and its audit record commit atomically. No recovery operation
creates, changes or deletes a Zoom meeting, sends an invitation or retries the
original request.

If the evidence is insufficient, the intent stays unresolved and candidate
publication remains suppressed. Older lost creation/update operations without
the operation reference cannot be inferred from a similar-looking meeting.
A missing search result likewise does not prove that a creation never happened.
Do not bypass these holds or automatically create replacements.

An account with active or unresolved managed meetings cannot be disconnected or
replaced by a different Zoom host. This includes meetings for client sub-tenants,
not only schedules in the staff member's home tenant.

## Verification boundary

Automated tests use isolated PostgreSQL fixtures and simulated Zoom responses,
including approval replay, concurrent creation, changed times, cancellation,
candidate isolation, OAuth browser binding and a provider-accepted/lost response.
They make no live Zoom calls and send no candidate emails.

Live acceptance still requires a correctly configured OAuth application and an
authorized staff account: connect, create one test meeting, change its time,
cancel it, and verify those results directly in Zoom and the candidate view.
