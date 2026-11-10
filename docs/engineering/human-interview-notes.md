# Human-interview recording notes — import foundation

## Available surface

Open a recruiter candidate profile and select **Meeting notes**. A job context
is required. An explicit `?jobId=` takes precedence over the profile's inferred
scored/matched role. The server independently requires an existing application
for this candidate and job. Being able to view the candidate elsewhere is not
permission to attach notes to an unrelated role.

Authorized active platform/employer/recruiter administrators, assigned recruiters
and the job's assigned hiring manager can use the feature. Candidate accounts,
unassigned recruiters and unrelated employers cannot. Ordinary interviewers are
not implicitly granted access.

1. Import one WAV, MP3, WEBM, MP4, OGG or FLAC recording, at most **50 MB**.
2. Record the staff member's attestation that all participants consented to both
   recording and AI processing. Lexy stores that attestation and timestamp; it
   does not establish legal sufficiency or independently verify participant consent.
3. Choose **Process recording** explicitly. Import does not trigger provider work.
4. Review the unlabelled transcript and source-grounded draft summary. Planned
   questions are stored as reference, not automatically assessed for coverage.
   Staff can separately annotate their coverage using exact transcript evidence.
5. Download through the authenticated attachment endpoint or explicitly delete
   the recording and its notes.

### Browser recording alongside import

**Development browser capture verified on 2026-11-04.** The real-browser harness
passes 22 checks, including decoding an actual synthetic recording and verifying
nonzero audio, preview/use/upload separation, cleanup, privacy errors and mobile
layout. This is not live conference-provider acceptance or meeting-bot support.
Existing recording import remains independently available.

The recording-only AudioContext is resumed in the initiating click and requests
a non-playing sink, rather than a speaker device. In isolated fresh Chromium
instances the default-output context could report running while producing no
recorded samples. Sources connect only to the MediaStream destination, with no
speaker branch. Browsers without the sink option ignore the dictionary member;
availability of shared audio still depends on the browser/device and selected
surface. This does not change interview speech playback or AI provider routing.

Staff can also choose **Record in browser** on the same Meeting notes panel.
This requires a separate pre-recording consent attestation, a supported desktop
browser, a shared meeting tab/window with audio, and microphone permission.
If the browser or selected surface does not expose meeting audio, recording
fails explicitly; microphone-only capture is not silently substituted.

Only the mixed audio is retained. Screen video is not recorded. Staff can stop
and preview the local recording, use it in the existing upload form, or discard
it. Stopping screen sharing also finalizes the recording; losing the microphone
discards the incomplete recording with an error. Duration is limited to the
existing 15 minutes. Size overflow fails explicitly rather than saving a
truncated success. Tracks, audio contexts and local preview URLs are released
on discard/unmount; pending permissions cannot revive a discarded session.

Local recording does not upload or invoke providers. **Use recording** only
selects a file; the existing upload consent and explicit upload are still
required, followed by the separate **Process recording** action. Closing or
changing context before upload loses local audio. Browser reload/close warnings
protect pending capture and selected files, but are not durable saving or a
guarantee that every in-app navigation can be blocked.

Microphone and meeting audio are mixed, not separated into attributable
speakers. Staff should preview audio before upload; the presence of a track does
not prove that every participant was audible. This is not automatic meeting
attendance, unattended recording, transcript diarization, or identity proof.
The existing provider routing and assessment separation remain unchanged.

This is **not** a bot that attends live meetings. Optional post-upload anonymous
speaker separation and human label review are described below; neither verifies
participant identity. It does not provide automatic question-coverage verification,
hiring recommendations, assessment scores, or automatic ATS write-back. No candidate
portal projection or scoring/learning consumer is connected to this table.

## Optional speaker separation and human labels

For an uploaded or retryable recording, staff may explicitly select **Also separate
anonymous speakers** before processing. Unchecked processing retains the existing
transcription route and exact empty request body. The optional path sends the
validated recording once to the existing Deepgram `nova-2` transcription model,
with a separately pinned `diarize_model=v1` and `utterances=true`. No interview
model, provider routing, summary prompt, rubric or existing saved result changes.
No processing is scheduled or automatically repeated.

Returned voice groups are anonymous, timestamped source evidence, not candidate
identity, a hiring assessment or a score. Overlapping speech is preserved. Missing,
malformed, unbounded, out-of-order or incorrectly versioned speaker evidence fails
explicitly; no guessed labels or silent provider fallback are saved. Unsupported
language/provider configuration returns 422 before a processing lease is claimed.
The server requires Deepgram diarizer metadata and retains the source build ID.

Staff can review the recording and explicitly confirm names/roles for existing
groups. These are **human annotations**, not voice identification. The server
supplies reviewer/time/revision and requires both the source revision and previous
review revision. Unknown/duplicate groups, spoofed reviewer fields, absent
confirmation and stale saves are rejected. Concurrent saves cannot overwrite one
another. Clearing annotations creates a new review revision without changing the
source transcript or segments. Reviewing labels does not invoke an AI/provider or
advance an applicant. Existing scoped staff authorization, deletion and erasure
barriers cover the same private row.

Migration `0108_meeting_speaker_evidence.sql` adds one nullable JSONB column. It was
applied only to the verified development target. External operators must apply it
before deploying this code; publishing is not assumed to migrate their database.
Plain-text notes export retains its existing transcript/question-review contract;
speaker evidence and human speaker labels are reviewed in the detail screen.

Provider contract checked against
[Deepgram diarization](https://developers.deepgram.com/docs/diarization.md) on
2026-11-04: the boolean `diarize` parameter is deprecated but maps to v1; an explicit
version avoids `latest` changing the diarizer. Do not send both parameters.
An absent `diarize_info` means diarization did not run, not verified single-speaker
audio. This implementation does not claim a live Deepgram acceptance test.

## Human-entered planned-question coverage

The detail screen offers a separate **Planned question review** for completed
recordings, or failed processing attempts that retain a transcript. Nonempty
trimmed question lines remain in their original order; up to 100 lines are
supported. Every question starts **Unreviewed**, never automatically Not covered.

Staff can choose Covered, Partly covered or Not covered. Covered/Partly covered
requires a verbatim excerpt that occurs exactly once in the current transcript.
An absent or ambiguous excerpt is rejected rather than guessed. The server
derives the source offsets (JavaScript UTF-16 text offsets, not audio timestamps)
and current staff attribution. A Not covered annotation has no excerpt.
Optional comments do not become scores or hiring recommendations.

The whole annotation set is saved explicitly. A SHA-256 hash binds the exact
transcript, including whitespace, and a UUID revision binds the previous saved
review. Atomic source/status/revision predicates prevent two staff sessions from
silently overwriting one another. A conflict preserves local edits and requires
loading the latest version before another save. Background refetches adopt new
reviews only when the form is clean; dirty forms are blocked on a changed source
or revision. A clear confirmation is also bound to the version displayed when
the dialog opened.

Clear saves an empty set with a new revision; it does not delete the source.
Reprocessing or deleting the recording clears its annotations. Known access
failures during a save hide cached private detail immediately and require a
fresh successful read for recovery. Source notes remain separate from hiring
assessment approval and immutable decision history: edits replace these
annotations rather than establishing an approved assessment audit trail.

## Download saved source notes

**Download saved notes** creates a UTF-8 `.txt` attachment from the current saved
record, not browser form state. It includes the transcript, AI draft summary if
available, consent attestation, planned questions and saved manual coverage
review. Export time, recording/job/candidate references, source hash, review
revision and reviewer reference identify the snapshot. These are source notes,
not an approved hiring assessment or immutable decision audit.

The authenticated `GET .../meeting-notes/:noteId/notes-export` endpoint uses the
same staff/job/candidate authorization as detail reads. Completed notes and
failed attempts retaining a transcript are eligible; uploaded/processing notes,
blank transcripts and deletion-pending notes return 409. Stale reviews bound to
a different transcript hash are omitted; their questions remain Unreviewed.
Exports never include storage paths, processing tokens, internal error messages
or media bytes, and do not call providers or write records.

Responses use `Content-Disposition: attachment`, `text/plain; charset=utf-8`,
`Cache-Control: no-store` and `nosniff`. The browser downloads an authenticated
blob rather than opening a public URL. Access denial hides cached source detail,
and leaving the note/context cancels an in-flight download. The interface and
file warn that unsaved edits are excluded and that deleting notes or revoking
access in Lexy cannot recall downloaded copies.

## Processing and recovery

Standard processing reuses the existing `transcribeAudio` routing unchanged.
The explicit speaker-separation option is isolated from that route. The existing
`generateWithAI` configuration is reused for a new source-only summary operation;
no stabilized model, provider, interview prompt or assessment rubric is changed.

The API decodes local media with `ffprobe`/`ffmpeg`, rejects durations over
**15 minutes**, and produces bounded mono WAV segments for the configured STT
path. Unsupported/corrupt/no-audio recordings fail processing rather than
inventing a transcript. Empty segment output is treated as incomplete capture;
there is no claim that every provider failure can be distinguished from silence.
Temporary media is removed in `finally`.

Each explicit attempt has a persisted, opaque ownership token. Concurrent starts
cannot both claim the same state. Authority and attempt ownership are checked
between stages/chunks and before results are saved. This is a recoverable
in-process attempt, **not a durable job queue**: after a server interruption,
staff can explicitly retry once the **20-minute lease** expires. Work is never
automatically repeated. Attempts stop at the next checkpoint after 15 minutes;
an already-issued provider call cannot be undone.

Summary failure may leave a captured transcript for staff review. A failed
attempt keeps the source recording. A retry can incur additional provider usage.
Deletion invalidates the attempt before storage removal; if storage deletion
fails, the row retains an explicit deletion-pending state for another Delete
attempt, not a success claim.

## Storage, privacy and erasure

Bytes use the project's existing private S3-backed object storage. This work does
not replace the storage provider. Paths are generated on the server beneath the
candidate recording prefix and are not accepted from clients or returned in DTOs.
The generic object route does not grant the uploader direct access: recordings
have a private service-owned ACL, and the job/candidate-authorized attachment
route supplies `Content-Disposition: attachment` plus `Cache-Control: no-store`.

The table is server-private: forced RLS, no public or `lexy_app` grants. Service
queries repeat tenant/job/candidate predicates. Candidate erasure inventories
collect its recording paths and remove its rows. The existing candidate prefix
purge covers imported bytes as well. A database trigger fences late inserts and
updates after candidate erasure, even for admin-pool processing.

An access-refetch failure hides cached list/detail source content. Changing
candidate/job context remounts the panel and clears form and selection state.

## Deployment prerequisites — not applied to production

- Apply `lib/db/drizzle/0105_meeting_notes.sql` and then
  `lib/db/drizzle/0106_meeting_question_review.sql` and
  `lib/db/drizzle/0107_meeting_notes_shared_erasure_barrier.sql`
  **before deploying this code**.
  Erasure collection now includes this table; the migration is not optional just
  because recording import has not yet been used.
- Make `ffmpeg` and `ffprobe` available on the API host.
- Retain the existing private object-store configuration and configured STT/AI
  access. No new provider credential or model configuration is required.
- Development migration was applied to the verified development database only.
  No external production schema, settings, account or candidate was changed.

### Erasure guard alignment

The recording-specific `meeting_notes_live_candidate` trigger remains enabled
to lock the candidate during recording writes. The additional standard
`lexy_erasure_write_barrier('candidate_id')` trigger satisfies the common release
schema contract and validates both old and new candidate references. This also
prevents an admin-pool update from re-parenting an erased candidate's source
material to an active candidate. The shared erasure security function must
already be installed; this migration does not replace that function or weaken
the readiness checker.

## Focused checks

- Five pure policy/media tests, including real local WAV decode and invalid
  media rejection, without provider calls.
- Opt-in `scripts/check-meeting-notes.ts`: real development HTTP authentication
  and database fixtures with mocked storage/transcription/summary. Tests consent,
  extra-field rejection, account/job/candidate isolation, attachment headers,
  explicit processing, completed-attempt refusal, deletion and erasure during STT.
- That fixture requires `MEETING_NOTES_TEST_DB_CONFIRM` to match a separately
  verified development target. It creates only synthetic example.test records,
  cleans up its own exact IDs, and is not an automatic live-provider test.
- All **14** HTTP/privacy/processing checks passed on the final service code.
  An initial timestamp-based claim check rejected a legitimate start because
  database timestamp precision exceeded the JavaScript representation; the
  claim now compares the persisted status/token/error state atomically.
- **17** existing erasure/barrier regressions passed after extending the inventory.
- The isolated browser pass used the real component with intercepted synthetic
  DTOs. It verified consent gating, exact multipart input, no automatic processing,
  explicit processing and result visibility, authenticated download, confirmed
  deletion, context resets, 403/404 cached-data hiding and a 390px layout.
  Its reusable harness is `artifacts/lexy/scripts/check-meeting-notes-browser.mjs`.
- Generated API types, shared-library compilation, strict API/frontend typechecks,
  API build/security guards, changed-file lint and formatting checks passed.
- Both development services restarted successfully. The API retains the existing
  dormant-Stripe administrative alarm; startup emitted its administrative
  notification. No billing settings were changed. Test fixture processing used
  mocked storage/AI and sent no candidate emails.

These checks do not establish live recording quality, external storage or model
availability, or complete Noon feature parity.

### Planned-question review verification

The follow-on review work passed **11 policy/media tests** and the expanded
**25 development HTTP/database checks** with storage and AI mocked. The latter
includes source-hash mismatch, spoofed attribution rejection, invalid/duplicate
question evidence, exact offsets, saved/read-back metadata, competing updates
(one succeeds, one receives 409), explicit clear and annotation reset on retry.
The development-only migration inherits the existing table's forced RLS,
server-private grants and candidate-erasure fence. No production database or
existing AI model/provider/interview prompt was changed.

The isolated real-browser harness
`artifacts/lexy/scripts/check-meeting-question-review-browser.mjs` passed **19
focused checks** with synthetic intercepted responses: exact excerpts and payload,
saved/remounted state, dirty-form conflicts, 409 behavior, clear confirmation,
denied-access hiding/recovery, 404, unavailable source, empty questions and mobile
layout. Web typechecks, changed-file lint/formatting, API typecheck and the API
build/security guards also passed. Browser fixtures and the web typecheck were
sequenced after a temporary-fixture cleanup race was observed; it was not a
product TypeScript error.

### Saved-notes download verification

The expanded suite passed **17** unit/media tests and **31** development
HTTP/privacy/processing checks with mocked storage/AI. Export checks cover
authentication, staff roles, foreign/mismatched contexts, missing/deleted notes,
unavailable or deletion-pending transcripts, failed summaries, attachment headers,
explicit-field serialization and zero additional provider calls.

The existing isolated browser harness passed **22** checks. Its three added
checks confirm an actual UTF-8 file is downloaded without navigation or a new
tab, a failed download produces an error, and a denied download hides cached
private source until a successful retry. Backend request behavior is tested
separately; the browser uses intercepted synthetic responses. No additional
database migration, production operation or model configuration change is
required by this download feature.

### Shared-erasure readiness verification

After applying the additional shared barrier to the independently verified
development target, the read-only recent-schema audit passed all **215** checks,
including the meeting-notes trigger. The expanded HTTP/database fixture passed
**33** checks, including enabled-trigger metadata and an attempted admin-pool
reassignment from an erased candidate to an active candidate. Reassignment was
rejected and the original ownership and empty processing results were preserved.
The original recording-specific trigger remains enabled. No production schema
or data was changed. This focused check is not a full assisted-baseline pass.
