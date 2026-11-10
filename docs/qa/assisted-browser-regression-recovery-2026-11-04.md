# Combined development gate and browser corrections

## Subsequent successful execution

The next combined run completed at `2026-11-04T17:25:55.187Z` with **56/56 groups
passed**, including the corrected browser groups and full-hour media coverage.
See [the latest result and boundaries](full-length-human-recordings-development-2026-11-04.md).
The earlier failure and corrections below are retained as historical evidence.

## Earlier combined execution

The preceding combined execution reported **52/55 groups passed**, with
exactly these failures:

- `meeting-notes-browser`
- `google-invitation-browser`
- `google-operation-browser`

Its report is temporarily stored at
`/tmp/lexy-assisted-baseline-KQJ9kD/summary.json`. The run began at
`2026-11-04T16:09:18.585Z`. All 1,170 API tests across 115 files, 283 frontend
logic tests, schema checks, strict API/web typechecks, API build/security guards,
lint and formatting passed. The other seven registered browser groups passed.
This is a newer execution than the historical 52/52 report.

## Causes and corrections

1. The meeting panel acquired a child requiring the real `AuthProvider`, while
   the old isolated harness supplied only a query provider. React therefore
   failed before the capture control could render. The harness now supplies
   the real authentication provider and intercepts a synthetic staff session.
   The read-only Google appointment path is explicitly intercepted too. No
   application auth rule was weakened or production credential supplied.
2. Invitation assertions still expected the previous unsupported-panel wording.
   They now check the current recipient-disclosure and guest-privacy notices,
   and continue asserting that an invalid panel has no send path.
3. Operation assertions still expected guest-only wording. They now check the
   candidate/panel notice and additionally require the full-panel calendar,
   working-hours and busy/unverifiable warnings.

The recording harness also waits for the actual control instead of a fixed
one-second delay, and includes uncaught browser errors in failure diagnostics
so an earlier render error is not masked by a missing-element message.

## Focused verification after correction

- Meeting notes/capture: **36 browser assertions passed**. Synthetic captured
  audio was decoded with nonzero signal. Explicit recording/upload/processing
  consent, source cleanup, speaker review, native Zoom import, private-cache
  recovery and unexpected-network checks were retained.
- Google invitations: **15/15 scenarios passed**.
- Google original-event operations: **13/13 scenarios passed**.
- Release registration/planner regression: **11/11 tests passed**.
- Strict frontend typecheck and changed-script formatting passed.
- Changed-script ESLint had zero errors; its existing eight warnings were not
  claimed resolved.

The focused tests waited for the combined execution's fixture lock. That wait
consumed part of the shell deadline, so the final operation group was interrupted
before completion and then run separately to its successful 13/13 conclusion.
The interrupted command is not counted as a passing combined command.

All three failed groups now have subsequent successful focused runs. The
original full report remains failed and was not rewritten into a green result.
No additional full combined execution is claimed.

## Boundaries

Only isolated browser-test setup/assertions and documentation changed. No
application source, schema, entitlement, AI configuration, provider grant,
production data, live invitation or meeting mutation changed.

These tests use intercepted synthetic responses, not a genuine signed-in LINX
session or live provider acceptance. Independent human approval, controlled
Google/Zoho/LINX acceptance, external production/AWS checks and the broader
product gaps remain separate.
