# Full-length human-meeting recordings — development

## Implemented scope

The human-meeting recording path now supports **60 minutes / 100 MiB**. The UI
uses the existing “MB” label for its binary byte bound. These are finite media
processing bounds, not plan, billing or complimentary-pilot restrictions.

The update covers local meeting capture, manual upload, native Zoom/Google Meet
eligibility and download bounds, the database byte-size check, actual decoder
duration checks, transcription parts and speaker evidence timestamps.

Oversized video should be exported as compressed audio of the **complete**
meeting. The application does not silently trim it to fit.

## Processing and safety

- Source content is still sniffed rather than trusting its extension/MIME.
- Private temporary decoding retains the file/pipe-only protocol whitelist and
  explicit accepted formats.
- A full hour becomes up to 144 sequential source parts. A bounded extra decode
  segment detects understated container duration; overflow is rejected, not
  returned as an apparently complete clipped recording.
- Up to four ordinary transcription calls run per batch. Results retain source
  order even when responses complete out of order.
- A failure settles the entire active batch before temporary-file cleanup.
  Later batches do not start and no partial transcript is reported as complete.
- Current staff/job/candidate access and attempt ownership are checked before
  and after provider work. Late results cannot bypass revoked authority.
- Processing has a 45-minute deadline; expired-attempt retry becomes available
  at 50 minutes, retaining an in-flight provider margin. The client follows the
  server's `canRetry` result.
- Storage downloads are byte-bounded as well as multipart/native-provider reads.
- Optional anonymous speaker separation accepts timestamps through second 3600
  and up to 6000 utterances, while keeping the existing total-text and response
  byte bounds. These groups do not identify meeting participants.
- Existing explicit capture/upload/processing consent, source-bound review,
  erasure fencing, private storage, RLS and human-approval boundaries remain.

The configured models, providers, routing, assessment rubrics and summary prompt
were **not changed**. The summary input remains capped at 100,000 characters.
If that independent bound is exceeded, the complete saved transcript remains
source evidence but processing fails rather than summarizing a silently truncated
input. Importing or summarizing still does not create an approved assessment.

## Database rollout

`lib/db/drizzle/0111_meeting_recording_bounds.sql` replaces only the historical
50 MiB check with a validated 100 MiB check. It uses bounded lock/statement
timeouts and does not alter grants, RLS, triggers, ownership or stored evidence.

This migration was applied through the explicitly selected **development**
database tool after checking its catalog metadata. The read-only meeting
readiness check now rejects the old, missing, weakened or unvalidated byte bound.
All six current meeting/usage readiness checks passed after migration.

**Production was not accessed or migrated.** External operators must review and
apply this migration to their verified target before rolling out the matching
larger-file feature. Republishing must not be assumed to migrate that database.

## Verification

- A real synthetic 60-minute WAV source decoded into all 144 parts. The summed
  decoded PCM count was exactly `3600 × 16000 × 2` bytes, with nonzero signal in
  every part. Cleanup and genuinely overlong-input rejection passed.
- Bounded concurrency, reverse-completion ordering, failure settlement and
  authority-loss tests passed.
- The focused API/provider/transcription batch passed **46 tests**.
- Local browser-capture logic passed **12 tests**, including continuing past the
  old 15-minute stop and stopping once at the new limit.
- Metadata/readiness and release-registration checks passed **14 tests**.
- Shared libraries and strict API/frontend typechecks passed.
- Root lint completed with zero errors and 523 existing warnings. The combined
  lint/format shell invocation reached its time limit during full-tree format
  scanning; that invocation is not counted as a formatting pass.
- Both development services restarted and came up successfully. The pre-existing
  Stripe-key acknowledgement warning still occurs on API startup; it was not
  changed by this feature.

The subsequent combined development regression **passed 56/56 groups**, with
zero failed groups. It ran from `2026-11-04T17:07:35.031Z` through
`2026-11-04T17:25:55.187Z` and included:

- **1,184 API tests** across 118 files in 33 bounded batches;
- frontend logic tests and strict frontend typechecking;
- all ten registered browser groups, including meeting notes/capture, controlled
  offers, Zoho campaigns and the Google/panel scheduling paths;
- schema/readiness checks, strict API typechecking, API build/security guards;
- root lint with zero errors and formatting with zero failing files.

The temporary machine-readable report is
`/tmp/lexy-assisted-baseline-u57dpw/summary.json`. This successful background run
supersedes the earlier 52/55 execution; the configured workflow's older failure
badge is not the result of this run. None of these fixtures proves live
Google/Zoom acceptance or every UI journey.

## Remaining limits

The multipart path remains memory-backed with a bounded per-file payload.
Concurrent large-file memory/capacity behavior is not production load evidence.
Live provider acceptance, real meeting permissions, external production rollout
and LINX staff acceptance remain separate operator checks.
