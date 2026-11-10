# Validation concurrency and preview recovery

## Observed failure

Two complete assisted-baseline processes were running concurrently against the
same development database. Several test suites use fixed fixture IDs. Their
overlapping setup and cleanup produced duplicate keys, missing authenticated
fixtures, and extra run-event rows. The affected gate results cannot establish
application regressions or production readiness.

Separately, the public-site and sales-brochure managed workflows had failed
because their existing ports were occupied by orphaned instances of those same
services.

## Correction

- The complete assisted gate now holds a workspace-specific Linux kernel lock.
  It acquires the lock before creating its progress report or executing tests.
- A duplicate invocation exits with code 75 and explicitly says no duplicate
  checks started. It is not reported as passed or silently skipped.
- The kernel releases lock ownership when the run and its descendants exit;
  an empty lock file does not prevent future runs.
- Interrupted duplicate validation processes were stopped. Only the identified
  orphan listeners for the two failed preview services were terminated; their
  existing managed workflows were restarted without changing ports or routing.
- The sourcing persistence suite now uses a per-execution namespace and clears
  its own disposable tenant's intelligence rows, including rows whose candidate
  no longer exists. An interrupted older fixture cannot affect its counts.
- This does not isolate independently launched fixed-ID tests. Those must still
  not overlap against the same database.

## Focused verification

- Four process-level lock checks passed: exclusion before fixture writes,
  preserved child failure status, release after an abruptly killed child, and
  independent workspaces remaining independent.
- An actual second assisted-gate command was rejected with exit code 75 while
  the canonical run remained active.
- The planner/progress/lock batch passed all 21 checks.
- The Lexy app returned HTTP 200. Both restored preview listeners returned their
  expected base-path redirects and their managed workflows were running.
- Changed JavaScript passed ESLint and formatting checks.
- The sourcing persistence suite passed all six checks after the fixture fix;
  genuine score persistence, rerun deduplication, employee-only mobility,
  honest empty results, protected identities, and Known Talent origin assertions
  were retained.

## Completed verification

The canonical, non-overlapping gate completed all 28 reporting steps.

- API batches executed 677 tests: 675 passed and two sourcing assertions failed
  because of old fixed-ID fixture rows. That batch ran before the sourcing
  fixture fix. The corrected suite subsequently passed all six of its tests
  with outbound-provider calls guarded.
- All three bounded workflow-journey groups passed: 27, 20, and 18 tests.
- Frontend logic: 128 passed.
- Controlled-offer fixture browser harness: 36 of 36 passed. This also supersedes
  the earlier standalone harness's startup-timeout evidence, without pretending
  that its failed workflow run was successful.
- Planner/progress/exclusion batch: 21 passed. Egress guard: five passed.
- Strict frontend and API typechecks passed.
- API build and ownership/privacy/rubric guards passed.
- Repository lint found zero errors. Formatting found zero differing files.
- The anonymous Lexy sign-in page rendered successfully in the app preview.

The original gate retains its failed status: one failed sourcing batch and its
failed API rollup are two reporting entries for the same two test assertions,
not two independent application defects. Its report was not rewritten. The
six passing sourcing checks are supplemental post-fix evidence, not a claim
that a fresh single-command full gate passed after that fix.

## Boundaries

No models, prompts, provider routing, plan entitlements, application permissions,
production schema, or historical Linx records were changed. No candidate
outreach or offers were sent. AWS callback, private-file access, and physical
file-deletion acceptance checks remain explicitly deferred at the user's request.
