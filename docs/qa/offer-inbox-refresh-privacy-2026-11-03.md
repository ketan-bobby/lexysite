# Offer inbox refresh privacy — 2026-11-03

## Change

The existing employer offer inbox no longer presents a failed cursor page's
cached candidate/offer rows. Failed first-page reads hide the whole list and
selected detail. An authorization denial on any page hides all rows and the
selected detail immediately, including while TanStack retries automatically.
The count uses only available rows; errors are not replaced by a false
"No offers assigned" state.

An ordinary additional-page error preserves successful peer rows but blocks
further pagination until recovery. Its retry warning remains visible even when
no rows remain. Retrying the whole inbox does not discard failure-bearing
pages until a successful, non-pending first-page read has a newer cache update
timestamp. A cancelled, pending or failed retry cannot reveal stale pages.

This changes presentation only. It does not change backend permissions, offer
ownership, human approval, sending, commercial access or any historical record.
No provider connection, database row, production configuration or stabilized
LLM setting was changed. Zoho reconnection/live acceptance remains deferred at
the user's request; the saved authorization was left untouched.

## Verification

- Sixteen new page/retry regression cases plus six existing offer-action cases:
  **22 passed**.
- Frontend strict TypeScript check passed.
- Changed-source lint has zero errors and one pre-existing unnecessary callback
  dependency warning in the inbox page.
- Changed-source formatting, baseline-runner syntax and patch whitespace checks
  passed. The new tests are registered in the existing assisted frontend gate.
- The main frontend workflow was restarted; its watched source updates were
  exercised by the browser pass. No API restart was required.

One focused browser tester exercised the real protected-route components with
synthetic auth/bootstrap and inbox responses, blocking non-read API requests:

- Additional-page 500 hides its cached row, retains the successful first row,
  blocks Load more, shows the correct count and permits fresh page recovery.
- The first additional-page 403 hides all cached rows and unmounts the selected
  detail/loading panel before automatic retries finish.
- A held first-page retry and then a failed retry keep the private views hidden.
  A successful fresh retry restores only current first-page rows.
- First-page 500 hides cached rows/detail, shows 0/0 and the error, and does not
  falsely display the empty state.
- No unexpected writes or subsequent application exceptions were observed.
  Intentional HTTP error responses produced expected browser resource errors.
  The initial bootstrap mock needed a correctly shaped empty jobs array.

Screenshots captured the first-403 hidden state, cursor-page error, fresh
recovery and first-page error. The tester did not exercise 401 navigation
because the global interceptor may sign out; both first/additional 401 cases,
including automatic-retry state, are covered by the pure regressions.

This is mocked UI coverage, not proof of real authentication, actual staff
revocation, backend row permissions, live offers or external delivery. The full
combined assisted suite was not unnecessarily rerun for this focused change;
the previous combined-run outcome remains recorded separately.
