# Candidate offer-page freshness

## Scope

The public candidate offer page previously had no periodic refresh or local
expiry clock. An idle page could continue showing response controls after its
displayed expiry until a later read or attempted response.

The page now refreshes server-owned state every 30 seconds while active, and on
mount/focus through the query library. A local clock disables responses at
expiry, including a separate check at confirmation-click time. Missing or invalid
time values fail closed. Accepted/declined responses are not relabelled expired.

Confirmation is scoped to the currently displayed offer version. Navigating to
another token creates a fresh response context rather than carrying the previous
choice or note. Response buttons pause while a fresh read is in progress.

The existing backend remains authoritative. This is not a live withdrawal push,
an amendment to offer terms, a hiring/employment decision, or a new automatic
offer sender. A local clock cannot prove server time or current server authority.
Background-tab timer throttling and network latency still apply.

## Verification

- Seven focused availability tests passed: authority, exact expiry boundary,
  accepted/declined/expired states, invalid clocks and invalid expiry.
- Frontend TypeScript, changed-source ESLint, Prettier and whitespace checks
  passed.
- Only the managed frontend workflow was restarted; it reported ready.
- Pure availability tests are registered in the existing assisted baseline;
  the full combined suite was not rerun for this focused change.

An isolated browser pass intercepted offer reads/responses with synthetic data.
Version-refresh invalidation, periodic authority loss, private-data hiding after
404, and cross-token form isolation passed. Its first short-expiry fixture elapsed
before the page became actionable, so it did not prove open-confirmation expiry.
Its first response fixture returned only a status rather than the required full
offer DTO, causing an error boundary. That invalid fixture is not evidence of a
failure with the documented API contract. The two affected scenarios were sent
back for targeted verification with a longer expiry and the full response shape.

Both targeted follow-ups passed. With expiry set 25 seconds after the initial
read, a valid Accept confirmation opened and then disappeared at expiry without
a reload or POST. With the full contract response, exactly one intercepted
acceptance POST produced the accepted state, recorded timestamp and echoed note,
with no response actions or error boundary. Together with the earlier passing
cases, all six requested browser behaviors have passing synthetic evidence.

No production, database records, provider calls, actual offer responses or emails
were used. These checks do not establish native backend offer acceptance or
production readiness.
