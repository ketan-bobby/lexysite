# Route-parameter type cleanup

## Delivered

The shared schema-validation middleware now returns a callback that remains
polymorphic over Express's matched route parameters. Previously its concrete
`RequestHandler` signature widened named IDs into the wildcard-capable parameter
dictionary.

This is a type-boundary correction, not a runtime ID conversion:

- Named job/candidate IDs remain scalar strings.
- Wildcard captures remain arrays of decoded segments.
- Regular-expression captures retain their scalar capture map.
- Validation still strips unknown body fields, returns the same structured 400,
  and places parsed values in `res.locals.validated`.
- Cookie HTTPS detection now accepts native `IncomingHttpHeaders`. Cookie
  security decisions, token issuance and authentication behavior are unchanged.

No IDs are cast to strings, flattened, trimmed or converted to UUID-only formats.
No ownership gates, compiler strictness, API contracts, models, prompts,
provider routing, sourcing access, pricing or historical Linx records changed.

## Compiler evidence

Matched full API checks, including test sources, using the unchanged project
configuration:

| Measurement | Result |
| --- | --- |
| Before | 501 diagnostics |
| After | 371 diagnostics |
| Removed, normalized by file/code/message | 130 |
| Added | 0 |
| Remaining ICP route diagnostics | 0 |

The full API compiler still exits nonzero. This does not represent complete
backend type cleanup or production readiness. Older production-only counts
cannot be compared directly to these full-scope counts.

The first attempted generic-factory signature did not remove diagnostics.
The returned polymorphic callback did. Its new negative type assertions are
included in the same full compiler graph and introduce no diagnostics.

## Verification

- 17 focused checks passed: real HTTP validation/route contracts, native-header
  cookie decisions, and existing token checks.
- 90 existing work-order, recruiting-configuration and sourcing-control checks
  passed, retaining foreign-tenant and assignment-related permission behavior.
- API build and existing security guards passed.
- Scoped lint passed without errors.
- New route and cookie tests are included in the assisted-regression manifest.
- Formatting and the nine batch/shard-planner checks passed.
- The managed API workflow was restarted successfully. The public login page
  rendered; unsigned 401/403 responses are expected. The existing dormant-Stripe
  sentinel warning remains unchanged and billing was not activated.

Private development logs:

- `/tmp/api-route-types-final.log` — full compiler output.
- `/tmp/route-boundary-tests.log` — focused checks.
- `/tmp/route-ownership-regression.log` — 90 existing regression checks.
- `/tmp/route-boundary-build.log` — build and security guards.
- `/tmp/route-boundary-lint.log` — scoped lint.

No real providers or candidate emails were used by these checks.

## Next cleanup group

Remaining diagnostics include other middleware-widened parameter types, unknown
test-response shapes, missing explicit returns and genuine nullable-field or
record-shape mismatches. Continue in bounded groups with matched compiler
comparisons; preserve scope checks and wildcard types rather than introducing
blanket casts or weakening compiler options.
