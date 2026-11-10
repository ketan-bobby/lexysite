# Assisted regression and first backend type-cleanup group

## Scope

This completes a bounded regression-runner and fixture cleanup, not all remaining
backend type errors or production acceptance of every recruiting journey.

- Ordinary API test files now run in deterministic batches of at most four,
  sequentially, with the existing 240-second per-process limit.
- Every manifest entry remains selected exactly once. Dedicated workflow-journey
  shards retain their existing disjoint parent/descendant selection.
- Planner checks cover exact coverage, invalid batch sizes and generated-name
  collisions. There is no increased concurrency, timeout or reduced test scope.
- Erasure write tests now provide complete, valid résumé-screen rows. Their
  rejection cannot depend on missing required score/summary fields.
- Erased candidate exports must fail authentication identically to anonymous
  requests when the erased profile no longer resolves to a portal identity.
- Private interview-queue fixtures execute the real erasure-policy SQL body
  against private temporary tables. Only that explicitly allowlisted function
  call is redirected; other public access remains forbidden. The private policy
  is checked for active, erased, tombstoned and missing-session subjects.
- Queue fixtures use real private sessions and claim jobs before completing them.
- Test imports, a fixture parameter's self-referential type and simulated-slot
  stage typing were corrected without changing runtime AI configuration.

## Verification

The initial complete regression invocation finished all checks rather than timing
out, but exited 1 because two API batches failed. Its original report is preserved.
Both failed batches were then rerun with their exact four-file manifests, the same
Node flags, egress guard and timeout. Unchanged successful checks were retained.

Current combined acceptance:

| Check | Result |
| --- | --- |
| API regression manifest | 557 passed across 14 bounded batches |
| Frontend logic | 55 passed |
| Batch/shard planners | 9 passed |
| Egress guard | 5 passed |
| Import-path regression checks | 73 passed |
| Frontend typecheck | Passed |
| API build and security guards | Passed |
| Repository lint comparison | 0 errors, 0 new errors |
| Repository formatting comparison | 0 failures |

The recovered batches passed 24 and 42 tests respectively. This is combined
verification evidence, not a claim that the original invocation exited zero.

Development-only logs and reports:

- `/tmp/lexy-assisted-baseline-dWsOYE/summary.json` — original failed run.
- `/tmp/lexy-assisted-baseline-dWsOYE/reconciled-summary.json` — original results
  plus exact-manifest reruns.
- `/tmp/backend-cleanup-fixed-tests.log` — focused export and queue checks.
- `/tmp/backend-imports-tests.log` — admission, Azure-pool and transcription tests.
- `/tmp/lexy-assisted-baseline-dWsOYE/assisted-api-other-10-final.log` — 42
  passing checks after making the private policy's search path fail closed.

The API workflow was restarted and is serving requests; the public Lexy login
screen rendered successfully. Its unsigned 401/403 responses are expected. The
existing dormant-Stripe-key sentinel warning remains unchanged; this cleanup
did not activate billing or alter secrets.

## Full backend typecheck remains incomplete

Matched full-scope compiler runs using the same configuration:

- Before: 512 diagnostics.
- After this group: 501 diagnostics.
- Normalized comparison: 11 removed, 0 added.

This scope includes tests. Do not compare these counts directly with older
production-only compiler reports. Strictness, includes, excludes and compiler
options were not weakened. The next cleanup group should address HTTP parameter
typing in bounded route groups while preserving runtime validation and
authorization responses.

## Unchanged boundaries

No AI models, prompts, language/provider routing, commercial tiers, external
sourcing access or cost gates were changed. These tests did not contact real
candidates or alter historical Linx work orders. AWS acceptance remains parked,
and actual Greenhouse acceptance still requires an authorized employer account.
