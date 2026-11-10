# Combined development release verification — 2026-11-04

**Later execution:** A subsequent expanded run passed 52/55 groups. Its three
browser failures were corrected and all three passed focused reruns; that is not
a new green combined execution. See
[the later result and recovery evidence](assisted-browser-regression-recovery-2026-11-04.md).
The 52/52 result below remains the historical execution described by its timestamps.

## Completed result

**Subsequent implementation:** Optional speaker separation and staff label review
were added after this execution. Their focused verification is recorded in
[speaker separation verification](meeting-speaker-review-development-2026-11-04.md).
The 52/52 result below predates those additions and is not claimed as their full
combined rerun.

**PASS: 52/52 groups, zero failed groups, exit code 0.**

Command: `pnpm test:assisted-baseline`

- Started: `2026-11-04T06:50:00.045Z`
- Finished: `2026-11-04T07:05:39.411Z`
- Final report: `complete: true`, `status: passed`, no active step.
- Duration: approximately 15 minutes 39 seconds.

This is a newly completed combined execution after the recording fix and release
manifest additions, not a reinterpretation of an earlier failed execution. No
failed group was waived. Application source did not need further changes.

## Coverage recorded by the runner

| Required checks | Groups | Result |
| --- | ---: | --- |
| Release planner/manifest regressions | 1 | 73 tests passed |
| Test egress guard | 1 | 5 tests passed |
| Recent, ATS and Zoho handoff development-schema audits | 3 | All passed |
| Bounded API test batches, including workflow journeys | 30 | 1,066 tests across 106 files passed |
| Aggregate API coverage check | 1 | All files/batches accounted for |
| Frontend logic | 1 | 280 tests passed |
| Strict frontend typecheck | 1 | Passed |
| Browser regression groups | 10 | All passed |
| Strict API typecheck | 1 | Passed |
| API build and configured security/authorization guards | 1 | Passed |
| Lint | 1 | Zero errors / zero new error fingerprints |
| Repository formatting | 1 | Zero differing files |
| **Total** | **52** | **All passed** |

The ten browser groups were:

1. Meeting notes and browser capture.
2. Controlled offers.
3. Zoho interview campaigns.
4. Panel invitations.
5. Google calendar reads.
6. Google invitations.
7. Google operation recovery.
8. Candidate Google Meet visibility.
9. Google panels.
10. Staff Google calendar connections.

Meeting capture includes real-browser decoding of synthetic captured audio and
nonzero-signal verification, not only fake recorder state. Its focused checks and
scope are detailed in
[meeting capture verification](meeting-browser-capture-development-2026-11-04.md).
This gate also includes the registered interview-plan validation, draft
work-order submission and Zoho application-identity regressions.

The runner's final JSON and per-group logs are temporarily available under
`/tmp/lexy-assisted-baseline-FbTpUC`; the background command log is
`/tmp/replit-background-tasks/e7870c68-2ea7-4d25-b5a8-45fbfb9e3785.log`.
This checked-in summary preserves the completed outcome after temporary files
expire. Older failed workflow cards were not restarted merely to repaint them.

## Boundaries that remain open

- Tests used the existing isolated/controlled development fixtures and egress
  restrictions. No production rollout, live ATS stage update, candidate mailing
  or human approval was authorized or performed by this run.
- Passing registered development checks is not acceptance with real employer
  calendar/meeting accounts, real Zoho applicant progression, a genuinely
  qualified candidate completing every live stage, or production/AWS operators.
- Single-application Zoho stage write-back is still an implementation gap
  pending the supported transition contract and explicit write authorization.
- Local browser source recording does not establish automatic meeting
  attendance or speaker attribution. Broader Noon parity remains incomplete.
- This suite includes configured build/security guards, not an exhaustive
  project security audit or every separately opt-in/browser/live-provider test.
- Lint warnings are not claimed resolved. No stabilized models, provider
  routing, prompts, pricing or internal Enterprise access were changed.

See the [current gap closeout](development-gap-closeout-2026-11-04.md) for the
human-approval, live-provider and external-rollout boundaries.
