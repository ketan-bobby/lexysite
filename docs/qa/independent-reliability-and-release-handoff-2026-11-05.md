# Independent development reliability checks and operator handoff

> Historical evidence: the Zoho transition investigation below predates the
> controlled stage-request implementation. Do not use its `Applications`
> endpoint claim as authority for a live write. The current verified adapter
> payload, approval boundaries, concurrency evidence and remaining work are in
> [Controlled Zoho stage writer](../engineering/zoho-controlled-stage-writer.md).
> Neither the old investigation nor the current adapter proves an employer's
> application-specific permitted transition or notification side effects.

Scope: development only. Do not use these synthetic checks as evidence that
production, provider delivery, live candidate consent, or employer authorization
has been accepted. No live invitation, offer, Zoho write or production migration
was performed.

## Latest completed regression — after the upload change

`pnpm test:assisted-baseline` completed with exit code **0** and a final report
of **complete: true**, **status: passed**, **56/56 checks passed**, **0 failed**.
Execution: 2026-11-05 12:23:01–12:39:35 UTC.

- 1,190 API tests in 121 files across 33 bounded batches.
- 283 frontend logic tests.
- All ten browser groups: meeting notes, controlled offers, Zoho campaigns,
  panel invitations, Google calendar, Google invitations, Google operations,
  candidate Google Meet, Google panels and staff Google calendar.
- Schema-readiness checks, strict frontend/API typechecks, API build and its
  authorization/rubric guards.
- Lint: zero total errors and zero new error fingerprints. Format: zero failing
  files.

The upload streaming, exact-boundary/abort tests and read-benchmark helper are
included in this execution. No failure required a code correction in this run.
The final execution report is
`/tmp/lexy-assisted-baseline-lqO5MG/summary.json`; temporary detailed logs may
not survive an environment restart, so the completed outcome is recorded here.
This supersedes the earlier pre-upload full-run evidence for current development
regression status, but does not certify live provider acceptance or production
capacity.

### Additional SDK-level coverage

After that full execution, a test-only follow-up exercises the installed AWS
SDK's actual serialization, checksum/chunk framing and signing middleware
using synthetic credentials and an in-process request receiver. It verifies
the complete unframed source bytes, encrypted/private metadata and explicit
failure on a synthetic 503 response. It does not contact AWS, read environment
credentials or establish actual bucket permissions. The full report above
predates this additional test; its result is not relabelled as including it.
The new test is registered for future combined regression runs.
Focused verification passed: the SDK test, all 11 test-registration/batching
checks, strict API typechecking and targeted lint. Application runtime source
was unchanged, so no new service restart or full-suite rerun was needed.

## Recording upload reliability

Manual human-meeting uploads now land in a private per-request temporary
directory (0600 file, 0700 directory) rather than a 100 MB multer memory buffer.
Only the header is read for media-type identification. The original file is
streamed through the existing private S3 service, with the same object tags,
encryption, persisted metadata and post-upload authorization checks. Temporary
bytes are removed on success, invalid upload, storage/persistence failure and
request interruption. The existing **100 MB inclusive** bound still applies;
duration validity remains checked during media processing (up to 60 minutes).

Synthetic loopback HTTP coverage checks four overlapping 8 MB uploads, exact
100 MB acceptance, 100 MB + 1 rejection, downstream failure and aborted
requests. A separately mocked storage test checks private tags, encryption,
ContentLength, streaming and closure on storage failure. The complete opt-in
meeting-notes fixture passed **102 HTTP/privacy/processing checks** with mocked
storage/AI, including its bounded 80-read diagnostic. This is not a production
concurrency or throughput rating; temporary disk capacity and provider upload
behavior still need operator load validation before production use.

## Six-stage recovery and authority

The focused recovery/campaign/Zoho validation run passed **12/12 tests**:
stale-run reconciliation and failure propagation; approval-before-dispatch,
synthetic completion, corrected human reviews, duplicate/uncertain delivery
holds; Zoho tenant/application binding, read-only metadata and revision checks.
An attempted broader combined run timed out without a final summary and is
**not** counted as passing. That interrupted attempt preceded the separate,
successfully completed full regression recorded above. Earlier 56/56 evidence
from before the upload change remains historical, not a substitute for the
new post-change execution.

## Zoho transition contract investigation

Official Zoho Recruit v2 documentation confirms `PUT
/recruit/v2/{module_api_name}/status` with `module_api_name=Applications` and
the application module UPDATE permission as a documented status-writing
surface. It also describes a separate
`PUT /recruit/v2/Submissions/{record_id}/actions/status` for submission
reviews; **a Submission is not an Application**. Pipeline history endpoints
return transitions already made, and the default stage catalogue does not
enumerate permitted next transitions for a particular application.

The documented application status endpoint does **not** by itself prove a
specific status change is legal for a given employer, job, application,
pipeline/blueprint or current state. Lexy therefore still uses local mapping
and reviewed export/simulation only: no remote status-write capability,
expanded OAuth scope, or automatic advancement has been added. The employer
must authorize write access and confirm a real application-specific
transition contract and failure semantics before implementing a controlled
single-application writeback with fresh-state verification and a human decision.

Sources:
- [Change Status](https://www.zoho.com/recruit/developer-guide/apiv2/change-status.html)
- [Change Submission Status](https://www.zoho.com/recruit/developer-guide/apiv2/change-submission-status.html)
- [Get Hiring Pipeline of a Record](https://www.zoho.com/recruit/developer-guide/apiv2/get-hiring-pipeline-of-a-record.html)
- [Get Hiring Pipeline Transition Details for an Application](https://www.zoho.com/recruit/developer-guide/apiv2/get-hiring-pipeline-transition-details-for-an-application.html)

## Operator release checklist

1. Confirm the external production API host and its actual database target
   independently; take a backup and review migration order. Migration
   `0111_meeting_recording_bounds.sql` is applied in development only; do not
   assume publishing updates the external production database. Do not run the
   synthetic fixture against production.
2. Confirm private storage encryption/tags, 100 MB upload path, disk headroom,
   interrupted-upload cleanup, media decoding and process memory under the
   intended number of concurrent uploads. Check provider receipts and retry
   behavior rather than claiming sampled dev RSS proves capacity.
3. Verify AWS/SES subscription and event receipts at the owned API origin
   without copying secrets into the handoff. An uncertain send must be reviewed
   instead of blindly repeated.
4. Have the work-order author submit the approved dummy job and a separate
   reviewer approve it. Preview/select only consenting synthetic recipients;
   execute one controlled invitation, complete one interview and record the
   human advancement decision. No synthetic review substitutes for people.
5. In each calendar/meeting provider account, confirm owner/host privileges,
   create/reschedule/cancel, visible candidate slot boundaries, link
   provenance and native recording import. Do not expose staff calendars or
   unrelated recordings.
6. Record pass/fail/blocked for each step with environment, time, safe receipt
   references and rollback owner. Do not mark fixtures or unavailable provider
   checks as live successes.

See [the Linx testing handoff](linx-testing-handoff-2026-11-04.md) and
[Zoho release checklist](../zoho-release-checklist.md) for the detailed
human-controlled acceptance sequence.

## Scope left after independent closeout

| Area | Current boundary |
| --- | --- |
| Existing development regression and upload reliability | Completed evidence above; SDK-only follow-up is separate from the full-run total |
| LINX dummy-applicant acceptance | Requires real attributable approval and a consenting interview tester |
| Provider recording and calendar permissions | Requires owned-account acceptance; in-process tests do not establish provider grants |
| External production/database/AWS rollout and capacity | Requires operator-owned target confirmation and live evidence |
| Zoho remote advancement | Still an implementation gap with transition-contract and employer write-authorization prerequisites, not a completed integration |
| Wider Noon comparison | Additional ATS adapters and live meeting attendance are not proven by this release; new adapters are product scope, not implicitly team-blocked finished code |

Do not add unrelated integrations, change stabilized AI configuration, repeat
passing tests, or bypass approval solely because live acceptance is waiting.
