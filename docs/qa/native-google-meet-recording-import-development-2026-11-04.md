# Native Google Meet recording import — development

## Implemented

On a staff-visible candidate, select the relevant job and open **Meeting notes →
Google Meet recording import**. Recording authorization is separately connected
under **Settings → Calendar**; a Calendar scheduling connection is not that grant.

1. Explicitly load the actor's eligible native appointments for this candidate/job.
2. Explicitly discover completed conferences in the server-derived appointment
   window, then select the exact instance. Even a single instance is not selected automatically.
3. Explicitly preview recording-file metadata, then select an eligible file.
4. Enter title, spoken language, participant/source consent statement and optional
   planned questions. Affirm consent and that this file/instance belongs to this applicant/job.
5. Import into the existing private, candidate-erasure-fenced meeting-note store.
   Import leaves the note `uploaded`: transcription, speaker mapping, summarization,
   assessment and ATS transitions are not automatically started.

The application exposes `native-google-meet/appointments`, `/conferences`,
`/preview`, `/import` beneath the existing job/candidate meeting-notes route.
There is no new database migration for this increment: the earlier nullable
native-source JSON/source-key columns and separate recording-grant table are reused.
OpenAPI source and generated client/server contracts include the new operations.

## Authority and evidence

- Active authorized staff, employer, current job/candidate visibility and the
  actual application are rechecked. A provider-visible file is not employer authority.
- Only currently confirmed/completed native Google interviews with an
  accepted organizer receipt, ready Meet URL and actionable job can be discovered.
  Saved Google panels additionally require the coordinator and current member
  bindings to match an accepted Google panel receipt. AI interviews,
  cancelled/unaccepted or uncertain provider changes are not import authority.
- The Calendar organizer receipt must still match the original Google account,
  connection revision, recipient and current appointment snapshot. Accepted
  reschedule chains must be complete, unique and current. The separate recording
  grant must resolve to the same Google subject as that original organizer.
- Discovery uses the receipt's meeting alias and the appointment start minus
  30 minutes through its scheduled end plus 60 minutes. No request can expand the window.
- A ten-minute HMAC review, using a provider-specific purpose, pins actor,
  employer, job, candidate, appointment/receipt, current recording grant,
  canonical space, exact conference, Drive object and full metadata fingerprint.
  Zoom and Meet reviews are not interchangeable.
- Before downloading, metadata and canonical space/conference evidence are
  re-read. The adapter checks Drive version/size/checksum before and after its
  bounded download. MP4 decoding and the existing 50 MB / 15-minute bound remain.
- Current authority and review expiry are rechecked after discovery, preview,
  download and the private upload, immediately before persistence. Failed final
  checks clean up the temporary private object. Deduplication-race recovery also
  rechecks source authority rather than returning a prior copy after revocation.
- Scoped source keys reuse the original imported private copy without redownloading.
  This does not refresh the old copy, revise its consent or represent new assessment evidence.
- Imported provenance labels Meet separately from Zoom. No tokens, playback URLs,
  arbitrary fetch URLs or private object path are exposed in the meeting-note DTO.

### Historical-alias limitation

Legacy accepted calendar receipts store the Meet alias, not its original
canonical-space identity. A fresh exact-space/instance preview is not proof that
the alias was historically assigned to that space. Staff must affirm the exact
instance/candidate/job association. This is consented source evidence, not a claim
of verified historic attendance or attributable speaker identity. If the current
receipt cannot be verified, use the existing separately consented manual-source
workflow rather than inventing an organizer receipt or broadening discovery.

## Verification completed

- API and web TypeScript checks passed; shared generated libraries rebuilt.
- Fourteen new isolated receipt/review/core cases passed: purpose/audience
  isolation, changed appointment/grant/subject, recycled aliases/file changes,
  consent, expiry, invalid media, idempotency and revocation races.
- The existing provider suite's twenty synthetic cases passed; no live Google traffic.
- The development-fingerprint-guarded HTTP fixture passed **70** combined
  meeting-note/private-processing checks, including thirteen Meet workflow
  groups. The real router/authorization, development DB reads/writes and existing
  private-note service were exercised, with Google/Zoom, storage and AI mocked.
  It verifies private source persistence, returned provenance, repeat reuse,
  consent failure, denied candidate/unassigned staff, download access, deletion
  and grant loss after download. Synthetic records/private objects were cleaned up.
- Release batching regression passed all eleven cases; both new unit files are
  registered once in the required API test manifest.
- Managed API restarted once after coherent source changes. Build security,
  tenancy/ownership/serialization guards and rubric lockstep passed; `/api/healthz`
  returned 200 with database access healthy.

## Signed-in browser evidence

One focused pass signed in through the real form with a synthetic tenant-admin
and development-only job/candidate/application. Only this fixture's Meet
operations and meeting-note list/detail responses were mocked; no live provider
or private storage calls were made. All five synthetic database rows were
removed and verified absent.

The browser confirmed no automatic provider reads, explicit appointment and exact
instance selection even for a single result, consent/title/statement gating,
consent reset after edits, the exact controlled import payload, successful
Google Meet provenance with `uploaded — not processed`, and access-loss clearing
the source selections and hiding selected private note details. A 402px
viewport showed wrapped consent text and no overflow from the new card.

The pass found one mismatch: a 409 dropped file/review/consent but retained the
appointment and conference selections. The failure branch now calls the same
complete state/cache reset that the browser exercised for access loss, forcing a
fresh selection after 409. This small correction was checked with TypeScript and
source inspection; no second full browser run was launched. A delayed-response
navigation test was not completed. The synthetic API fixture initially used an
incorrect array for `plannedQuestions`; correcting it to the actual string
contract rendered the note detail. This was a test fixture correction, not an
application transcript-processing change.

## Not claimed

No live Google recording consent/download/import was attempted. Staff Google
app setup is still required in this development environment. Real Google scope
verification, a host-owned consented dummy recording, independent Linx acceptance
and deployment validation remain external/operator work. No production writes,
schema changes, publishing, AI model/provider/prompt changes or commercial
restrictions were introduced. The previously failed full assisted-baseline run
was not reclassified as green. This increment is not a meeting bot, automatic
attendance proof, synchronized panel event changes or complete Noon parity.

Panel invitation/recording support was subsequently added in development; see
[the panel receipt and acceptance boundary](google-meet-panel-recordings-development-2026-11-04.md).
