# Human-controlled native offer replacement

## Delivered behavior

Eligible designated employer staff can explicitly prepare a fresh draft after
expiry or withdrawal. Previous terms are visible read-only and prefilled as a
reference only after the reviewer clicks **Prepare fresh draft**. The local form
starts with an empty expiry, requiring a new future deadline and manual review of
the letter. Preparation and discarding do not persist anything.

Saving uses the existing `save_draft` contract and latest workflow revision. It
creates a new offer ID/version in draft status, without approval, response token
or delivery metadata. Previous terms/history are retained, and old candidate
response links stay closed. The new draft must separately be submitted for review,
approved by the designated human, and explicitly sent.

The server's redundant raw `sent` rejection previously also blocked records whose
effective status was already expired. The lifecycle status guard still rejects
live sent, in-flight/uncertain, accepted and declined offers. Only expired or
withdrawn records receive this replacement path.

The shared editor covers both the work-order workflow and employer offer inbox.
Closed/no-offer views now have a finite 15-second freshness path so another
reviewer's new draft does not leave the closed view permanently stale. Concurrent
dirty-draft protection and explicit resolution remain intact. Approvers can read
saved terms and the letter without term-edit authority.

## Checks

- Twelve draft-availability policy tests and ten existing synchronization checks:
  22 passed. New policy tests are registered in the assisted baseline.
- Targeted controlled-offer API suite: 15 reported tests passed. Renewal assertions
  cover withdrawn and expired sent records, new IDs/versions, preserved history,
  absent approval/delivery authority, closed old links, and no automatic dispatch.
  Existing live-sent refusal and authority/version checks remain passing.
- Strict frontend and API typechecks: passed.
- Scoped ESLint, Prettier and whitespace checks: passed.
- Both managed services restarted; API build/source guards passed and the server
  listened normally. Existing dormant-Stripe configuration warnings remain
  unchanged; billing was not enabled. Its pre-existing startup sentinel issued an
  administrative alert, unrelated to offer test dispatch.
- Browser verification used the real editor with strictly intercepted synthetic
  API requests, not a real account or public authentication bypass.

The browser pass verified expired preparation, blank-expiry refusal, returned
fresh v2 rendering/history, withdrawn draft discard, ownership/eligibility
denials, all excluded lifecycle states, preserved edits during a concurrent
replacement, latest-revision saving, context reset and 390px layout. Only
simulated draft saves were permitted; no real approval, delivery, provider call
or candidate email was performed.

The first pass's second simulated save returned v4, but the mock GET still served
v3. A narrow follow-up identified that stale test snapshot; synchronizing the fake
GET/cache to the successful response displayed v4 with retained terms and no
conflict. This corrected the fixture state without changing production behavior.
The first save's immediate v2 rendering was independently verified in the main
pass.

The follow-up also verified a review-required approver with no edit authority:
full salary and manual letter were readable, no editable fields or Save appeared,
Approve was available and Send absent. Neither action was clicked and this check
introduced no additional API request. No full browser-suite rerun was performed.

## Scope

No models, prompts, provider routing, tiers, pilot access, payment controls,
historical Linx work orders, offer outcome semantics or fee calculations changed.
Automated checks do not certify multilingual human grading or a live employer
offer delivery journey.
