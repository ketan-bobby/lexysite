# Recall connection and live-attendance boundary

## Implemented

The project Recall API connection passed a read-only bot-list authorization probe.
No bot was created and no meeting URL or candidate data was sent.

Platform administrators can repeat this diagnostic at **Settings → ATS connections →
Meeting assistant · Recall**. The endpoint is `GET /api/meeting-assistant/readiness`.
It returns only a sanitized state and check time, never bot lists or connection metadata.
It selects a single connection explicitly, refuses ambiguity and does not retry failures.
The selected region is applied by the connector; the application does not override it.

**A successful connection check is not proof of live meeting attendance.** The optional
attendance implementation now lives in the candidate/job **Meeting Notes** panel. It
requires a managed Zoom appointment hosted by the current staff user; it does not
enumerate candidate calendars or accept arbitrary meeting URLs.

This is not an entitlement restriction, cost guard or change to interview models.
Development-only migration `0112_meeting_attendance.sql` adds service-private
workspace grants, appointment attempts, replay IDs and a minimal cleanup outbox.
Production has not been accessed or migrated.

## Implemented attendance controls

1. Employer-authorized Recall workspace binding: project integration access alone does not
   authorize every employer or every recruiter to record meetings.
2. Explicit per-appointment approval and participant notice/consent, current job/candidate/
   host checks and a visible `Lexy — Interview Assistant` participant.
3. Durable attempt claims before one provider write; prevent duplicate dispatches and hold
   uncertain outcomes for recovery instead of blindly sending another assistant.
4. Stop/cancel/revocation and candidate-erasure handling for provider-side media as well as
   local records. Avoid losing a bot identifier while its recording may still exist.
5. Verified lifecycle webhooks, with replay protection. Recall's current docs explicitly
   discourage production lifecycle polling.
6. Audio-only capture without Recall transcription; explicit reviewed import into existing
   private meeting notes, using unchanged transcription/summary routing. Capture alone is
   neither an approved assessment nor a hiring action.
7. Provider usage observations with unknown-cost semantics, not an activation/payment gate.
8. One consented dummy Zoom meeting to verify admission, capture, stop and private import.

Items 1–7 have implementation and development regression coverage. Item 8 remains
a live acceptance check; mock-backed tests must not be described as a real meeting.

### Lifecycle setup before the first live dispatch

- In the connected **US West 2** Recall workspace, configure the development
  endpoint `/api/meeting-assistant/recall-events` under Webhooks.
- Create a **workspace verification secret** in Recall Developers → API Keys &
  Secrets and put it in development Secrets as `RECALL_WEBHOOK_SECRET`.
  This is not the Recall API key. Never paste it in chat.
- Legacy accounts created before December 15, 2025 may instead use the endpoint's
  Svix signing secret. Both complete `webhook-*` and `svix-*` header sets are supported.
- The receiver verifies the raw body with HMAC-SHA256, checks delivery age within
  five minutes, deduplicates hashed event IDs and refuses older state regressions.
- Recall delivers lifecycle events through the dashboard endpoint, not through
  `recording_config.realtime_endpoints`. Configure this before dispatch; the UI
  checks secret presence, not proof that the dashboard endpoint is reachable.
- Platform admins explicitly authorize the employer workspace in Meeting Notes.
  The original managed Zoom host then records participant consent, approves the
  appointment, and separately confirms dispatch. No automatic calendar-wide joining.

### Capture, stop, cleanup and erasure

Capture is audio-only, without Recall transcription, video, participant-event
recordings, speaking, or scoring. The visible participant sends a capture notice,
including to new arrivals. The host's explicit consent attestation remains required;
a notice is not consent. Recording length uses the existing one-hour notes processing
limit, not a subscription tier. Provider media retention is explicitly 24 hours.

Dispatch claims commit before the one create request. Timeouts, malformed success
responses and missing receipts enter `unknown`; no automatic resend occurs.
Recovery reads the exact opaque attempt/dispatch metadata and refuses zero,
multiple or paginated matches. Original hosts and authorized employer admins can
recover or stop an existing attempt; only the original host can approve/dispatch.

Stop and workspace revocation persist cleanup intent; they do not claim immediate
deletion. A scheduled bot uses Recall's scheduled-bot DELETE; an active bot receives
leave_call. Once ended, delete_media removes provider media. Failed cleanup remains
pending and is retried by leader-only maintenance. Authority/account/appointment
changes also request cleanup. Maintenance never creates a bot.

Candidate erasure queues a minimal independently committed stop intent and refuses
to report completion until provider media has been removed. A database DELETE
trigger also protects unresolved receipts. Unknown creation outcomes remain on
hold for receipt recovery; they are not treated as zero-recording successes.
The outbox contains only attempt IDs and is removed after transferring durable
stop intent to the attempt.

Reviewed import downloads a unique completed MP3 only from an allowlisted Recall
S3 media host, refuses redirects, bounds bytes and decoded duration, rechecks current
authority, and saves it through the existing private meeting-note storage path.
It neither transcribes automatically nor creates an assessment or ATS publication.
Successful import requests provider-media deletion, while the private source copy
follows the existing recording erasure process.

Each Recall proxy request uses the existing vendor-usage observer with cost status
`unknown`. No rate or zero-cost assumption is invented, and metering does not add
an activation/payment gate.

## Provider references

- https://developers.zoom.us/docs/meeting-sdk/linux/ — SDK guidance directs AI notetakers to RTMS.
- https://docs.recall.ai/docs/zoom-overview — supported joining and waiting-room behavior.
- https://docs.recall.ai/reference/bot_create — recording configuration and webhook requirements.

Do not implement an unsupported Linux Meeting SDK bot. Do not equate a successful
Recall authorization probe with independently verified joining or usable audio.
