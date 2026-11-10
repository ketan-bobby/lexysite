# Offer inbox cursor reconciliation — 2026-11-03

## Scope and behavior

The existing offer-inbox API sorts by descending workflow update time and ID.
Its opaque cursor denotes that ordering boundary; it is not a snapshot token.
An independent poll can change a parent's next cursor while already-loaded
child pages still use the former boundary. Deduplicating workflow IDs alone
cannot recover an offer displaced into the resulting gap.

The client now passes the actual requested cursor keys into the page assembler.
Only the currently linked prefix is displayed. If a boundary changes, the
affected suffix is removed, a visible status notice explains the reset, and
Load more follows the current boundary. Valid preceding pages, search/filter
state, selected workflow URL and independently gated detail remain intact.
This is a bounded reset, not an automatic scan of every offer.

The assembler still checks **all** queries for authorization denial, including
obsolete suffixes. Reconciliation is disabled while any page reports lost
access; explicit successful fresh-read recovery remains required. A pending
page alone does not trigger a reset, and an old-boundary response cannot be
stitched into a differently keyed current chain.

An empty page with a continuation cursor now offers Load more rather than
falsely declaring that no offers are assigned. This matters because the server
can filter entries after scanning its bounded raw workflow page. Repeated
cursors stop pagination with an explicit error instead of an enabled no-op
button or a claim that the whole inbox is loaded.

No API, schema, database, ownership, approval, sending, commercial-access,
provider or LLM change was made. Production and historical Linx records remain
untouched. This does not create a transactional snapshot of a changing inbox;
counts and search still refer to loaded rows.

## Completed checks

- Frontend strict TypeScript check passed.
- **33 focused tests passed:** the prior 22 page-privacy/retry/action checks
  plus 11 cursor-reconciliation cases. These cover stable boundaries,
  first-page insertion and promotion, a changed middle boundary, end-of-list,
  pending parents, obsolete-page 401/403, filtered-empty continuation,
  cursor loops and late old-boundary responses.
- Changed-source ESLint: zero errors, one pre-existing unnecessary dependency
  warning in the inbox callback.
- Tests remain registered through the existing assisted frontend gate.
  The whole combined baseline was not rerun for this bounded frontend change.

## Browser evidence and limits

One focused pass used the real protected-route components with synthetic
auth/bootstrap and inbox GET responses. Non-read API calls were blocked; the
write log and captured page-exception list were empty.

- Root-boundary reset hid old later rows, displayed the notice, and preserved
  All loaded, the matching search term, selected workflow URL and held detail
  loading marker. The next request used the new cursor.
- New cursor pages recovered displaced rows without duplicate workflow IDs.
  A middle-boundary change retained the first two valid pages, removed the
  obsolete third page and recovered its displaced row from the new boundary.
- An empty root page with a cursor exposed Load more, not a false no-offers
  state; following it reached an available offer.
- A repeated cursor produced the explicit pagination error with no Load more.
- A cached third-page 403 hid all rows/detail while the root poll was held.
  Releasing a changed-boundary root success did not remove that denial.
  Explicit successful Retry access restored only current first-page data
  while preserving search/filter/selection.

The first cursor-recovery fixture initially returned an unintended empty
page. After correcting the fixture, the tester used UI Refresh before checking
recovery. Therefore the reset state and correct new-cursor recovery are
verified, but that pair was not an uninterrupted no-refresh journey. An initial
privacy-fixture response was also corrected before the successful privacy
scenario. Neither correction changed application code.

Screenshots document root and middle resets, recovered rows, empty-page
continuation, repeated-cursor error and retained obsolete-page denial. This
proves mocked UI behavior, not real staff authentication/revocation, backend
permissions or live offer delivery. The separate real-session test remains
outside this change.

Subsequent real development staff-suspension evidence is recorded in
[Real staff-session offer access](offer-inbox-real-session-access-2026-11-03.md).
It supplements this mocked pagination pass rather than changing its provenance.
