# Linx development testing handoff

**Independent follow-up (2026-11-05):** Manual 100 MB meeting uploads now use
private temporary disk files and streamed private storage instead of a full
in-memory multipart buffer. Development verification, Zoho API findings and
the external operator checklist are in
[the reliability and release handoff](independent-reliability-and-release-handoff-2026-11-05.md).
**A new post-change combined regression completed on 2026-11-05: 56/56 checks
passed**, including 1,190 API tests, 283 frontend logic tests and ten browser
groups. Earlier pre-change results remain historical; see the linked handoff
for this execution's evidence and limits.

## Google Meet recording authorization update

The separate optional staff recording connection now exists at `/settings/calendar`.
Its development migration and targeted authorization/security tests are complete;
Calendar grants are unchanged. Recording import/review controls are now
implemented in development, while live Google restricted-scope consent still
needs operator setup and controlled acceptance. See
[the implemented import/review scope](native-google-meet-recording-import-development-2026-11-04.md)
and [the authorization setup notes](google-meet-recording-authorization-development-2026-11-04.md).

## Purpose and boundary

Use this checklist to test the existing Lexy workflow without confusing
development regression coverage, real provider acceptance and future Noon
feature parity. This is a test handoff, not production approval or a claim that
every competitor feature has been implemented.

Use the development Lexy preview. Do not change production configuration,
databases, LLMs, provider routing, prompts, rubrics or commercial tiers.
Complimentary internal Enterprise access remains unchanged.

Only use the approved dummy job/applicant and explicitly approved test inboxes.
An imported ATS record is not permission to email it. Do not re-import records
or repeat completed interviews merely to populate this checklist.

## Before the first test

- [ ] Identify the development environment and the intended Linx employer.
- [ ] Record the dummy work order, candidate and application in the private
      test worksheet, not in this shared document.
- [ ] Confirm the test candidate's email belongs to the consenting tester.
- [ ] Have the work-order author submit its draft for review. Drafts are not
      awaiting approval until submitted.
- [ ] A different authorized reviewer approves the work order. Do not bypass
      separation of duties or fabricate that review.
- [ ] Confirm the saved interview plan has the intended questions.
- [ ] Assign one coordinator to record pass, fail, blocked or not run and keep
      the relevant receipt IDs/timestamps. A disabled account, missing
      permission or unavailable reviewer is blocked, not passed.

## Test order

| Order | Where / action | Expected result | Status |
| --- | --- | --- | --- |
| 1 | Work Orders (`/jobs`), open the dummy work order | Draft can be submitted; the authorized independent reviewer can review it; approval is visible after reload. An author cannot approve their own submission. | Not run in this handoff |
| 2 | Settings → ATS connections (`/settings/ats`), inspect the existing Zoho connection and dummy records | Confirmed employer identity and exact job/applicant association. Existing imports are reused; no duplicate candidate or application. | Needs account-owner acceptance |
| 3 | In the Zoho interview campaign, preview applicants, inspect the saved plan and approve only the intended dummy recipient | Exact reviewed recipients and plan; no invitation before human batch approval. A page reload retains campaign progress. | Needs explicit send approval |
| 4 | Open the resulting interview invitation as the test candidate | Verification and consent work; Lexy introduces herself; spoken answers are captured; a refresh honestly resumes saved progress; completion is persisted. | Needs consenting candidate |
| 5 | Open the completed interview and its evaluation as authorized staff | Transcript, recording, available scores and review state agree. Missing evidence is unavailable, not fabricated. Candidate-owned private coaching is not employer assessment evidence. | Needs completed test evidence |
| 6 | Record the human next-stage decision and inspect the ATS handoff | Current human decision is authoritative; prior history remains. A simulated/exported handoff is labelled as such and does not claim to update Zoho. | Local review can be tested |
| 7 | Settings → Calendar (`/settings/calendar`), then schedule an approved dummy interview from its workflow | Candidate sees only published slots. Staff calendars, private events and panel details are not exposed. Native confirmation and external provider booking have separate evidence. | Needs owned test calendars |
| 8 | With the organizer, explicitly approve provider invitation, reschedule and cancellation | Correct organizer, intended attendees and current join link. Changes reconcile with the provider. An uncertain response is held for review, not blindly retried. | Needs controlled live approval |
| 9 | Candidate profile in the correct job context → Meeting notes | Manual upload/browser capture requires consent. Private source playback/download works. Transcription/summary requires a separate staff action; notes do not automatically become an approved hiring assessment. | Ready for consenting source test |
| 10 | Same Meeting notes panel → native Zoom recording import | Only the original host's eligible Lexy-managed appointment is selectable. Explicit preview, consent and source confirmation precede import. Repeating the same import reuses one private copy; no automatic processing occurs. | Needs eligible host grant and recording |
| 11 | Offer inbox (`/offer-inbox`) for an eligible synthetic hiring decision | Designated human staff review exact terms/version and approve before any explicit send. AI does not independently issue, negotiate or approve offers. | Needs authorized human roles; no send without approval |
| 12 | Repeat selected reads as an unauthorized staff user and candidate | Foreign candidate/job content is denied. Candidate cannot see staff-only evaluation, calendar or private recording material. Revoked access hides cached private content. | Controlled role test |

The Zoho applicant interview campaign does not need an invented first-contact
Interested reply: its separate batch approval authorizes invitations to the
reviewed existing applicants. Native sourced-candidate outreach follows its own
interest/review gates. Do not manufacture evidence to make the two paths look
identical.

## Explicitly unfinished or separate

- **Native Google Meet recording import/review is implemented in development,
  but live authorization and acceptance remain outstanding.** See the
  [implemented controls and limits](native-google-meet-recording-import-development-2026-11-04.md).
  Meet calendar invitation/join-link features are different. Staff Calendar
  access is not authorization to read Drive recordings.
- **Live Zoho application stage write-back is not implemented.** Current reviewed
  mapping/export/simulation does not advance a remote application. Do not enable
  write scopes or change remote stages to improvise a test.
- **Automatic live meeting attendance/bot behavior is not implemented by recording
  import.** Anonymous speaker separation and staff source labels are not verified
  participant identity.
- Imported human-meeting media now supports **100 MB / 60 minutes** in development.
  [Full-hour source coverage and rollout notes](full-length-human-recordings-development-2026-11-04.md)
  describe the tested bounds, unchanged AI settings and required production
  migration. The combined development regression passed 56/56 groups; live
  provider acceptance remains separate. No longer source is silently truncated.
- Additional ATS vendors, stronger independently validated fraud detection,
  independent certification and performance-at-scale evidence remain broader
  competitive work, not prerequisites for testing the existing dummy workflow.
- Production/AWS storage and SES-event acceptance require the external operators.
  Nothing in this handoff changes or verifies production.

## Handling failures without duplicate actions

Record the screen, action, time, expected result and actual result. Put receipt
IDs in the private worksheet. Never include passwords, tokens, verification
codes, signed recording URLs or client secrets in shared reports.

- If an invitation or offer is uncertain, inspect its attempt rather than resend.
- If an interview is completed, inspect its saved evidence rather than generate
  a new interview automatically.
- If access is denied, verify employer/role/job assignment rather than weaken it.
- If a recording is unavailable, verify the original host's permission and
  eligible recording instance. Do not browse unrelated recordings or calendars.
- Do not mark blocked/not-run items passed. A local/mock result does not prove a
  provider side effect.

## Engineering evidence

The latest focused native Zoom evidence is in
[native Zoom verification](native-zoom-recording-import-development-2026-11-04.md).
The previous complete release result and its boundaries are in
[the combined verification](assisted-release-verification-2026-11-04.md).

During preparation of this handoff, the restored combined gate exposed an old
catalog expectation for the usage area constraint. The newer meeting audit
already required reviewed migration 0076, while the old catalog audit still
expected the pre-activity expression. Both now share the strict reviewed
contract. No schema change, relaxed constraint or payment gate was introduced.
The corrected read-only development audit passes **215/215 checks**; **18/18**
focused schema/checker tests pass. These focused results do not rewrite the
in-progress combined run or its earlier failure.

### Completed combined run and targeted correction

The combined run completed at 09:50 UTC on November 4: **52 groups passed and one
failed**. The sole failed group was the stale usage-constraint expectation
described above, executed before its correction. The original report remains
failed; it was not edited or relabelled as green.

The passing groups include **1,090 API tests**, **280 frontend logic tests**,
all ten registered browser groups, both typechecks, the API build/security guards,
the other three schema audits, lint with zero errors, and formatting with zero
unformatted files. Native Zoom provider/review tests and the expanded meeting
browser checks were included. Independent checker/manifest checks after the fix
passed **18 schema tests** and **11 manifest tests**. The corrected development
catalog audit passed **215/215**. Existing lint warnings are not claimed resolved.

These results support controlled testing of the implemented scope. They do not
constitute an all-green rerun of the complete command, live-provider acceptance,
or production approval. No unchanged journey was rerun simply to replace the
failed historical workflow card.

The original combined report is temporarily at
`/tmp/lexy-assisted-baseline-T4NZfb/summary.json`; this document preserves its
outcome after temporary files expire. The public login rendered successfully and
the development API readiness check returned healthy with a successful database
probe. No application runtime changes were needed for the checker correction.

## Google Meet recording source import

Development now includes a separate optional recording account plus
appointment-linked conference discovery, exact-instance/file preview, explicit
source/participant consent and controlled private import on the candidate's
Meeting notes tab. Imports remain unprocessed source evidence, not approved
assessment or automated ATS decisions. Existing calendar grants are unchanged.

API/web type checks, build security guards, fourteen new isolated cases and the
70-check combined development HTTP/private-processing fixture passed. Provider,
storage and AI calls in those fixtures were synthetic. No production writes or
new migration were needed for this increment. See the
[application evidence and remaining live boundary](native-google-meet-recording-import-development-2026-11-04.md).
Live Google app/scope setup, a consented host-owned dummy recording, panel
recording support and independent acceptance are not represented as complete.

### Google panel increment

Organizer-approved saved Google panel invitations and recording imports are now
implemented in development. All panel recipients are shown before approval and
the provider receipt must match that exact set; stale solo/Outlook receipts
cannot become panel authority. Current member/grant/consent checks also fence
recording reuse and late downloads. The combined HTTP fixture now passes 79
groups, with synthetic provider/storage/AI adapters, plus 48 focused backend and
three route cases. See [panel scope and evidence](google-meet-panel-recordings-development-2026-11-04.md).
Panel event updates/cancellations are now implemented with separate human
approval in development; see [change controls and limits](google-panel-operations-development-2026-11-04.md).
Live Google acceptance is still not claimed.
The organizer-only time-change limitation is now closed in development:
[full-panel conflict checks](google-panel-conflict-checks-development-2026-11-04.md)
verify member calendars, working hours and buffers before Google updates.
The extended synthetic-provider development fixture passes 98 combined groups.
Candidate-portal panel Join links are now supported through canonical self
ownership and current private panel verification. The extended development
fixture passes 90 groups with synthetic provider/storage/AI adapters; see
[candidate Join scope](candidate-google-panel-join-development-2026-11-04.md).
The browser component pass used an isolated synthetic host, not a signed-in LINX
account; it verified recipient review, blocked stale approval, one controlled
synthetic POST, malformed/403 privacy recovery and the 402px dialog.

Candidate Join publication now also makes a read-only check of the original
Google event, withholding stale links after external edits/deletion or unknown
provider results and rechecking local ownership/consent afterwards. This is
read-time verification, not background synchronization or automatic recovery.
See [live-link development scope and evidence](google-meet-live-link-check-development-2026-11-04.md):
79 focused tests and 101 combined development fixture groups pass with synthetic
provider transport. The earlier counts above describe their individual increments.
Controlled live Google/LINX acceptance and the full release checks remain pending.

### Latest combined regression and corrections

The latest expanded combined run passed **56/56 groups**, including 1,184 API
tests across 118 files, all ten registered browser groups, strict API/frontend
typechecks, API build/security guards, schema checks, lint and formatting.
It completed at `2026-11-04T17:25:55.187Z`. See
[the current result and scope](full-length-human-recordings-development-2026-11-04.md).
The earlier 52/55 run and its isolated corrections remain documented as
[historical evidence](assisted-browser-regression-recovery-2026-11-04.md).

A subsequent test-harness-only update separately passed 102 scoped HTTP/privacy/
processing checks and an 80-read bounded concurrency diagnostic. See
[measurements and strict scope limits](development-meeting-notes-read-benchmark-2026-11-04.md).
This is not production load certification or a replacement for live acceptance.
