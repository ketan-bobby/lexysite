# Assisted release verification — 2026-11-02

For the newer completed consolidated execution, including the reviewed Zoho
handoff download, see [the November 3 verification](assisted-release-verification-2026-11-03.md).

## Result

**PASS: 49 of 49 check groups; zero failed groups.**

- Command: `pnpm test:assisted-baseline`
- Environment: development workspace only, not the externally hosted production API.
- Started: 2026-11-02 11:47:14 UTC.
- Completed: 2026-11-02 12:02:46 UTC.
- Command exit code: 0.
- Lint: zero total errors and zero new error fingerprints.
- Formatting: zero total failing files and zero new failing files.

This is a fresh command-line execution. It does not change the status or
historical result of the older `assisted-baseline` managed workflow.

This latest execution supersedes the earlier 10:15–10:30 UTC execution as
consolidated evidence. It includes the compliance-analytics authorization,
job-creation development-privacy and role-alert safety changes. Their focused
findings and verification remain documented in
`compliance-analytics-authorization-review.md`,
`job-create-development-privacy-review.md` and `role-alert-safety-review.md`.

The subsequent manual reviewed-handoff download is documented in
`../zoho-interview-campaigns.md`. Its focused unit/browser/typecheck results
are separate evidence; the consolidated execution above predates that addition.

## Verified scope

The consolidated runner passed its batch-planning and outbound-request safety
checks, development schema checks, 25 API batches, three workflow-journey
batches, aggregate API checks, frontend logic, strict frontend/API typechecks,
and the API build with its authorization guards.

The API groups passed 1,016 tests across 101 files in 28 bounded batches.
The frontend-logic group passed 216 tests. These counts exclude the separate
batch-planner and egress-guard tests and the nine browser groups.

The API batches include candidate-detail privacy and assignment regressions,
the private-development firewall, and candidate-self-only connection insights.

All nine registered browser groups passed in the same consolidated execution:

- Controlled offers.
- Zoho interview campaigns.
- Panel invitations.
- Google calendar reads.
- Google invitations.
- Google operation recovery.
- Candidate Google Meet visibility.
- Google interview panels.
- Staff Google calendar connections.

The earlier panel-browser navigation failure did not recur in this run. No
timeout, access rule, model, prompt, routing or provider setting was changed to
obtain the passing result.

## Remaining boundaries

The six previously tracked Class-B analytics/job-creation review exceptions
were addressed by the separate reviews linked above. The current API build
and authorization guards pass. That closes those identified review items,
not every possible platform security concern.

This execution does not prove every UI journey, live third-party provider
acceptance, production schema alignment, or Linx team acceptance. It does not
enable Zoho stage write-back or remove human approval from controlled offers.
No production access or mutation was performed.

## Detailed evidence

The machine-readable report and per-group logs for this execution are in the
temporary directory `/tmp/lexy-assisted-baseline-emVT34`. This checked-in summary
preserves the result and its limitations after those temporary logs expire.
