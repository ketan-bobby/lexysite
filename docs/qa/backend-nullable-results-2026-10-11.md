# Nullable results and response handling — 2026-10-11

## Changes

- Both candidate résumé parsing paths validate structured AI output before
  saving it. Null, empty-object, primitive, malformed-JSON and invalid known-field
  shapes use the existing recoverable `ok:false, parseError:true` response.
  Saved parsed profiles/signals and candidate social URLs are not overwritten
  on those failures. Valid partial output remains supported, including zero
  years, explicit nulls, absent fields and additional fields.
- The learning assessment access helper consistently supplies an empty
  unlocked-course array when the pilot is unavailable. Existing owner checks,
  prerequisite rules, course completion requirements and response statuses
  remain unchanged. No entitlement configuration was changed.
- Null profile completeness explicitly behaves as zero for the existing
  complete-profile recommendation, preserving the previous comparison behavior.

Models, generation parameters, prompt text, providers, rubrics, approvals,
external sourcing and free pilot access are unchanged. No historical candidate
profiles, interviews, Linx work orders or hiring decisions were rewritten.

## Evidence

- Eight new offline checks passed after correcting the assessment-helper
  edit location. Six cover the structured parsing boundary and both actual
  route bodies; two cover the actual assessment-access helper.
- Route bodies are extracted from current source and transpiled into isolated
  contexts. Auth, DB, storage, model and side effects are substituted. Checks
  assert no profile/social writes on invalid output, expected successful
  persistence, zero-year preservation, and no model/write activity on
  unauthenticated requests. These are not real DB, S3 or live-provider tests.
- The twelve earlier offline regressions passed during the initial combined
  run; one new learning check initially failed and passed in the focused rerun.
  No passing earlier measured behavior was changed by that correction.
- Matched production-only compiler scope: **432 → 410 diagnostics**.
  Twenty-two resolved and zero added by file/code/message comparison.
  The compiler still exits nonzero; no full-project typecheck pass is claimed.
- Changed-source ESLint: zero errors, eight existing warnings. New helper/test
  formatting and whitespace checks passed.
- Existing client callers already handle the retained parsing success/failure
  envelopes and preserve previous interview personalization on parse failure.
- API/web services restored; API build and existing security/privacy,
  frozen-rubric and prompt guards passed. Public sign-in screenshot renders.
  This is not an authenticated portal browser acceptance test.

No candidate messages or paid AI calls were initiated for this batch. Existing
dormant-Stripe startup alerting sent its administrator warning on API restart;
billing configuration was not changed.

AWS live verification, human multilingual review and real ATS connectivity
remain deferred/separate. Remaining compiler diagnostics require individual
inspection rather than being classified collectively as harmless.
