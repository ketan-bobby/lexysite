# Shared middleware and return-path cleanup

## Result

Full API compiler diagnostics fell from **250 to 191**, with **59 removed and
zero new diagnostics**. Of the remaining diagnostics, 90 are in non-test
sources (including scripts) and 101 are in test code. These counts do not
represent separate confirmed runtime failures. The full typecheck is not clean.

## Changes

- Preserve named, wildcard and regex route inference through origin guards,
  rate limiting, capacity admission and interview-cookie middleware.
- Extract scalar rate-limit IDs without coercing wildcard arrays. Existing
  interview routes, rate caps, scopes and valid-session keys are unchanged.
- Use the public `safeParse` validation contract shared by both installed Zod
  generations, preserving parsed locals and structured 400 responses.
- Make nine analytics callbacks' fall-through returns explicit; response bodies
  and error statuses are unchanged.
- Type existing custom-question arrays and the named recording-segment request,
  and remove a redundant `null ??` term from notification-owner fallback.
  Question ordering/content, prompts, model/provider routing and scoring remain
  unchanged.

No new pricing limits, sourcing restrictions, schema migrations or historical
Linx edits were made.

## Verification

- 49 functional regression checks passed across shared parameter contracts,
  both Zod versions, CSRF behavior, semaphore handling, interview runtime
  consent, and transcription consent.
- Compile-time positive/negative assertions cover named and wildcard parameters,
  and HTTP cases cover regex captures, hostile-origin rejection, rate limits
  before admission, capacity release exactly once, and missing-cookie session IDs.
- New middleware contract checks are registered in the assisted baseline.
- Nine batch/shard-planner checks passed with the updated manifest.
- Scoped lint: zero errors, 19 warnings.
- API build and its existing security guards passed.
- Managed API restart succeeded; the public login preview rendered normally.
  The existing dormant-Stripe configuration alert remains unchanged.

Evidence: `/tmp/api-common-middleware-final.log`,
`/tmp/common-middleware-regressions.log`, `/tmp/common-middleware-lint.log`,
`/tmp/common-middleware-build.log`.
