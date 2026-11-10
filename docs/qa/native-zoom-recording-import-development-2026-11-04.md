# Native Zoom recording imports — development verification

## Delivered

The staff human-interview notes panel can import an existing Zoom cloud recording
from a confirmed, Lexy-managed appointment for the current candidate and job.
Listing appointments is local only. Checking Zoom and copying a selected file are
two separate, explicit staff actions; no meeting bot, polling, invitation, ATS
write, transcription, assessment or hiring decision is triggered by importing.

Only the original Lexy staff host can preview/import using that host's connected
employer-owned Zoom grant. This does not use the project owner's connector as
staff authorization or browse an account-wide recording library. Manual pasted
meeting links are not sufficient evidence.

The preview shows actual recording and appointment times. Staff must attest to
participant consent and the correct recording instance/candidate/job. This is
source provenance, not automated participant identification.

## Source and persistence safeguards

- Job/candidate/staff authorization precedes provider I/O. The appointment join
  checks both native schedule and managed receipt tenant, application job and
  candidate, confirmed receipt status, and current host ownership.
- A signed ten-minute review binds the caller, tenant, job, candidate, schedule
  revision, operation, account revision, meeting instance UUID and file metadata.
- Import re-reads recordings by the reviewed UUID, not whichever meeting instance
  is latest when a numeric meeting ID is used. Special UUIDs are double-encoded
  according to Zoom's documentation.
- Provider metadata, download streams, media type and real media duration are
  validated. Only HTTPS Zoom recording paths are accepted; redirects cannot
  forward bearer credentials to unrelated hosts/CDNs.
- Scope/account/appointment authority is rechecked after remote work and before
  private persistence. Changed recordings or expired reviews require a new
  explicit preview, not an automatic retry.
- Native copies use the existing private object-storage and erasure-fenced note
  row. No provider URL or token is persisted in source provenance or returned as
  a browser download link.
- Source keys deduplicate retries; a database unique index also covers concurrent
  imports and duplicate temporary objects are removed.
- Existing 50 MB / 15-minute processing bounds remain visible. These are resource
  bounds, not a paid-tier restriction.
- Zoom reads/downloads receive tenant-scoped `activity:recruiter` request receipts.
  Cost remains unknown without billing evidence; success is not a cost estimate.

## Development database

Applied `0109_native_meeting_recording_source.sql` only after verifying the
development target. It adds nullable provenance/source-key fields and a unique
source-key index on the existing table; existing manual uploads remain supported.
The required read-only meeting/usage schema check now validates these additions.

**Production was not read, migrated, deployed or modified.** An external
production rollout still requires the reviewed migration path.

## Verification performed

- 57 real HTTP/development-DB checks with mocked Zoom, object storage, media and
  AI. Includes original 46 checks and 11 native-import checks: unauthorized/
  candidate/unassigned/foreign-host access, local-only listing, preview without
  download, consent and strict input, explicit import without processing, retry
  deduplication, schedule/source drift, authority change during download, and
  concurrent duplicate cleanup.
- 36 real Chromium UI checks against synthetic fixture responses. Includes
  explicit preview/import steps, both attestations, unchanged processing count,
  stale and forbidden response cleanup, source display, original capture/
  speaker-review regressions and a 390-pixel no-overflow check.
- 29 focused API unit tests across recording provider/review, meeting core and
  speaker evidence, including the 12 new native-provider/review tests.
- 14 schema/manifest unit tests and the actual development read-only schema check.
- API and frontend TypeScript checks and changed-component lint.
- Managed-preview verification caught a separate instrumentation incompatibility
  with explicit JSX type arguments. The call now infers its generic through a
  typed callback; the API contract and runtime import behavior are unchanged.

These checks do **not** prove live Zoom cloud-recording permissions, licensing,
availability, download routing, or participant consent. No real Zoom recording
was accessed or downloaded, and no candidate messages were sent by these tests.
The earlier combined assisted-baseline result predates this addition; it has not
been re-run for this change.

Development startup also triggered the existing dormant-Stripe-key sentinel and
its platform-admin security email. Billing was not activated and secrets were not
changed; this is separate from the native-recording tests and candidate messages.

## Remaining

1. With staff approval, verify one consented dummy cloud recording through the
   original host account. Zoom needs `cloud_recording:read:list_recording_files`
   or the applicable legacy `recording:read` permission and an eligible account.
2. Add the equivalent native Google Meet recording path with separately verified
   staff authorization. Calendar access alone is not Drive/recording permission.
3. Longer interviews need a separately bounded processing design; this change
   does not silently raise existing media/resource bounds.

Official reference consulted:
<https://developers.zoom.us/docs/api/meetings.md>, “Get meeting recordings.”
