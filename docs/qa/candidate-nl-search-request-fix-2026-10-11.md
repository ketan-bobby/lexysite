# Approved natural-language search request repair

The user approved correcting this search request only on 2026-10-11.

## Change

Removed the filter-default object passed as the optional system-prompt argument
to `generateJSON`. The call now uses the helper's existing JSON-only instruction.
The main natural-language search prompt is byte-for-byte unchanged.

No other AI arguments, helper implementation, model choices, provider routing,
language routing, interview prompts, scoring, pricing or access controls changed.

## Checks

- Four request/helper contract checks passed. They execute the current search
  call and shared JSON helper against a provider double, not a live AI provider.
- Checked the default instruction, `en-US`, temperature zero and seed 42.
- Checked valid structured results, omitted optional arrays, fenced JSON,
  invalid JSON and provider errors. Errors propagate; no fabricated empty
  search results are introduced.
- Nine test-runner planning checks passed; the new request tests are registered
  in the assisted baseline.
- Scoped lint passed with zero errors; existing warnings remain.
- Compiler diagnostics: **161 → 160**, zero new. Full typecheck remains failing.
- Source comparison confirmed exactly one optional argument changed, while
  all three main AI prompts and the shared AI module match the checkpoint.
- Managed API rebuild/security checks and restart passed; login preview rendered
  normally. The pre-existing dormant-Stripe configuration alert is unchanged.

Evidence: `/tmp/nl-request-tests.log`, `/tmp/nl-request-planner.log`,
`/tmp/api-nl-request-final.log`, `/tmp/nl-request-lint.log`.
