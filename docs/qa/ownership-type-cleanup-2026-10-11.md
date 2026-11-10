# Ownership middleware and intelligence feedback cleanup

## Scope

- Ownership and named-exemption middleware preserve the matched Express route
  parameter types. Helpers that do not depend on a particular parameter layout
  accept unknown parameter layouts. Runtime caller resolution, assignment gates,
  ID extraction, admin exemptions and 401/400/404 responses are unchanged.
- Eight intelligence route callbacks explicitly finish their handled responses.
  Response bodies/status codes, scoring, policy decisions and action routing are
  unchanged.
- Feedback history now accepts native arrays and legacy JSON-encoded array
  strings, preserves existing entries, and writes native JSONB arrays as the
  canonical override writer does. Invalid history fails rather than being
  discarded or overwritten.
- No model, prompt, provider routing, commercial/sourcing access or historical
  Linx data changed. Tests use existing isolated fixture namespaces and blocked
  external egress.

## Compiler comparison

The full unchanged API compiler graph includes test sources:

| Measurement | Result |
| --- | --- |
| Before | 371 diagnostics |
| After | 342 diagnostics |
| Removed, by file/code/message | 29 |
| Added | 0 |
| Remaining diagnostics in changed source/test files | 0 |

The full compiler still exits nonzero. This is a bounded improvement, not a clean
backend typecheck or proof of all six workflow stages.

## Verification

71 checks passed across ownership middleware, the private route ownership sweep
and the history parser. They cover:

- Scalar named ID and wildcard-array compile-time contracts.
- Recruiter-owned, unassigned, missing/malformed and aliased resources.
- Caller fallback, administrator exemptions and named exemption registration.
- Feedback native arrays and legacy input, preserved earlier oversight entries,
  scoped peer denial without mutation, and malformed-history rejection.
- SQL `jsonb_typeof` confirms successful feedback writes physically store arrays.

Scoped lint passed with zero errors and five existing warnings. API build and
existing security gates passed. The assisted baseline retains the existing
ownership suites and now includes the pure history parser checks.

Formatting and nine batch/shard-planner checks passed. The managed API was
restarted and the public login preview rendered normally. The existing
dormant-Stripe sentinel warning remains; billing configuration was not changed.

Logs:

- `/tmp/api-ownership-types-final.log`
- `/tmp/ownership-regression-final.log`
- `/tmp/ownership-lint.log`
- `/tmp/ownership-build.log`

The fixture's legacy-string round trip was not assumed to preserve a physical
JSONB string: comparisons use the saved pre-request state, and storage-shape
assertions use SQL. The pure parser independently exercises raw legacy strings.

## Remaining scope

Continue bounded compiler cleanup without blanket casts, exclusions or weakened
permissions. This pass does not establish concurrent-append safety for feedback
or override history: existing read/modify/write behavior remains.
