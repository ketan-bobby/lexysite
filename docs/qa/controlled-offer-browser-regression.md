# Repeatable controlled-offer browser checks

Run from the workspace root:

```sh
pnpm run test:offer-browser
```

The same command is registered as the `offer-browser` validation. To run one
named group while diagnosing a failure:

```sh
pnpm --filter @workspace/lexy run test:offer-browser "Concurrent"
```

The runner uses the existing Puppeteer dependency and installed Chrome, or the
system Chromium on PATH. It fails explicitly if neither is available. It starts
a temporary loopback-only Vite server with its own dependency cache and no API
proxy, then closes its browser/server and removes its cache. No running app
workflow or signed-in user is required.

## Coverage

Thirty-six browser scenarios render the actual shared controlled-offer editor,
human decision/correction controls, generated API client and React Query behavior:

- The request guard itself blocks an unknown outbound route and a non-allowlisted
  send action. Those deliberate requests are never forwarded.
- Expired offer replacement requires explicit preparation and an expiry; saving
  displays the returned draft, retains old history and does not approve/send.
- Withdrawn replacement can be discarded without writing.
- Sent, sending, uncertain-delivery, accepted and declined offers have no
  replacement/edit shortcuts (five independent cases).
- Missing edit ownership and missing current eligibility prevent replacement
  (two independent cases).
- Concurrent remote replacement retains edits and blocks save until the human
  resolves the conflict; the next save uses the current revision.
- Discarding conflicting edits loads the latest saved terms without writing.
- Changing job/workflow context resets prepared replacements and dirty terms.
- Read-only approvers can see the full terms/letter but cannot edit/send;
  approval confirmation requires the manual letter check.
- Human submission, approval and send are separate explicit interactions.
- Unsaved changes cannot send an older approved version.
- Past expiry is rejected before any request, retaining the local terms.
- A failed save retains edits, blocks review of the unsaved version, and retries
  with the same idempotency key before displaying the saved terms.
- The replacement form fits a 390px viewport.
- Uncertain-delivery evidence checks require explicit human confirmation and do
  not resend.
- Settlement requires a reason, provider evidence, acknowledgement and separate
  review; its synthetic result clears approval and requires review again.
- Changed delivery attempts/revisions block stale reconciliation confirmation.
- Unauthorized recovery viewers cannot open reconciliation controls.
- Legacy uncertain offers without an attempt remain held.
- Lost current hiring eligibility blocks submission, approval and sending while
  preserving withdrawal and investigation of an existing delivery.
- Offer confirmation and manual-letter acknowledgement are cleared when
  eligibility or designated authority changes, even without a revision change.
- Final-decision confirmation is cleared after loss of approver authority, job
  approval or current-brief eligibility; restoring access requires fresh review.
- Changing candidate workflow clears the prior decision intent and private reason.
- An open correction closes when authority is revoked and cannot silently reopen.

The runner reports passed, failed and unrun counts and returns a failing exit
code for assertion errors, browser exceptions, unexpected requests or bootstrap
failures. An initial shared startup failure stops the run instead of repeating
the same failure for every scenario. UI waits have finite timeouts.

## Safety and limits

All state is synthetic and recipients use `example.invalid`. Interception is
installed before navigation. Every API request is intercepted: only registered
synthetic job/workflow offer reads and per-scenario allowlisted mutations receive
fake responses. Unexpected requests are aborted and fail the case. The optional
web-font CSS is replaced locally; other external requests are blocked. The test
server has no API proxy as a second boundary.

Successful fake mutations update both the response and later fake GET snapshots.
Otherwise a stale fixture can wrongly appear to be an application cache bug.
The test checks the editor's requests and visible behavior; its fake backend is
not proof of server authorization, real delivery or database persistence. Keep
the existing controlled-offer API regression suite alongside it. No real
candidate offers, emails, sourcing or provider calls are made.

Production code, models, prompts, provider routing, commercial access and
historical Linx work orders are unchanged by this suite.

The shared offer form now also validates finite positive compensation,
real calendar start dates, field lengths, supported pay frequency and future
expiry locally. Expiry is rechecked at the save click, not only while rendering.
These checks provide earlier guidance; server validation and authorization
remain authoritative. No new date restriction was added to the server.

Both the browser suite and offer terms unit tests are included in the assisted
baseline gate, in addition to the standalone browser validation.

Final-decision mutations now invalidate the workflow, offer, routing, employer
inbox item and all filtered inbox lists immediately. Seven real React Query
checks prove matching views are invalidated without touching other workflows
or unrelated private data. Thirteen action-policy checks cover current designated
authority, hiring eligibility and the recovery exceptions. The server remains
authoritative and no commercial gate was added.

## Recorded verification

On 2026-10-12 the registered validation passed all 17 scenarios in approximately
14 seconds, with zero failures or unrun cases. Scoped lint, formatting and
whitespace checks also passed. This is synthetic UI-contract regression evidence,
not certification of a live employer delivery or an authenticated staff session.

The follow-on form/retry work passed all 19 browser scenarios and 53 focused
frontend tests (31 terms checks plus 22 availability/synchronization checks).
The expanded reconciliation pass verified 23 of 24 cases. Its one failure was
an incorrect test selector for the existing **Review settlement** button, not an
application failure; a focused rerun after correcting that selector verified
the remaining case. No previously passing cases were needlessly repeated.

The follow-on authority and decision work passed all 31 offer scenarios in one
run. After introducing the separate decision entry, another run retained all 31
passes but its decision bootstrap failed because both transformed HTML entries
used the same document URL. Vite reused the wrong inline-module entry. Giving
the decision fixture its own URL fixed that isolation bug. The focused `decision`
run then passed all six selected scenarios (five new decision cases and one
previous offer-recovery case), verifying all 36 distinct browser cases across
the runs. The 20 new action/cache tests and frontend typecheck also passed.
