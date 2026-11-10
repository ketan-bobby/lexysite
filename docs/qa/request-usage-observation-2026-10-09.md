# Non-blocking per-request usage observation

Internal testing is not gated by billing evidence, rates or these reports.
No models, provider routing, prompts, subscription settings or candidate records
were changed.

USD planning allocations no longer prevent preparing multiple approved test
runs, revising advisory amounts or acquiring their execution leases. Run-count
and candidate/time/provider limits remain human-approved scope controls, not
subscription or payment limits. Native discovery is tested above its advisory
USD allocation with fake transport; quoted per-operation metering remains
separate from the unpriced internal-testing path.

## Captured evidence

- Each instrumented HTTP attempt keeps its own identifier, scope, provider,
  model, status, latency, retry index and observed usage.
- Whitelisted response headers can attach non-secret request identifiers.
  SerpAPI body identifiers must be 24-character hex; Deepgram body identifiers
  must be UUIDs. Arbitrary body IDs, profile fields, URLs, headers and balances
  are not retained.
- PDL `X-Call-Credits-Spent` is recorded as provider-reported credits, including
  an explicit zero. Missing credit information is not inferred from results.
  Documentation:
  https://support.peopledatalabs.com/hc/en-us/articles/30980638555547-How-do-I-view-the-number-of-remaining-credits-for-my-plan
- Slow JSON receipt capture does not wait indefinitely before returning the
  original response. Late observations update the same attempt without another
  provider call. Accounting and logging failures do not reject execution.
- The existing JSON column stores receipt metadata; no SQL migration or RLS
  modification is required.

## Read-only platform-operations reports

Daily aggregates:

```sh
pnpm --filter @workspace/api-server exec tsx src/scripts/vendor-usage-report.ts 1
```

Individual attempts:

```sh
pnpm --filter @workspace/api-server exec tsx src/scripts/vendor-usage-report.ts 1 --requests
```

The individual report is capped at 10,000 rows and announces possible truncation.
These are internal operations reports, not employer-facing APIs or invoices.
They cover instrumented attempts, not necessarily every account charge.

Only exact supported direct-OpenAI text/embedding models with sufficient reported
usage receive a **public-rate estimate**, using the existing dated references.
Cached input is not counted twice, reasoning tokens are not added to output
again, and missing cache details remain unknown. Proxy rates, Azure deployments,
aliases, speech, subscription-credit conversions, failed/uncertain requests and
account discounts are not guessed. Verified USD cost remains null until
attributable billing evidence exists. Estimates never authorize or limit work.

## Verification

25 focused usage/coverage/cost tests passed with outbound vendor access denied.
They cover receipt sanitization, observed credits, estimates, original response
preservation, delayed receipt updates, persistence failures, SDK retries,
streamed transcription uploads, scope isolation and database/application-role
security. Transport tests use fake providers; no real sourcing request, email or
provider purchase is part of this verification.

All 47 sourcing-control tests also passed, including native execution without
pricing above the advisory allocation, concurrent preparation, idempotency,
authority, tenant isolation and uncertain-effect recovery. The receipt JSON
was additionally verified through actual database persistence with application
role access denied. Frontend typecheck, library typechecks and changed-file lint
passed; existing full API typecheck issues elsewhere remain outside this change.
The read-only individual report returned 21 recent observations with no
confirmed USD charges or computed estimates; unknown costs remain explicit.
