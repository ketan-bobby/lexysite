# API test-fixture compiler cleanup

## Scope

Resolved the remaining 101 API test-fixture TypeScript diagnostics across 17
existing test files. Application behavior, AI models, prompts, language/provider
routing, complimentary Linx access, offer approval, and historical business
records were not changed.

- Use native database insert/role types and scoring contracts in fixtures.
- Check optional SDK fields before reading them.
- Validate unknown HTTP JSON without stripping unexpected response fields:
  privacy assertions must still detect leaked fields.
- Exercise the actual frontend recording helper through a validated runtime
  import rather than copying it, excluding tests, or widening the API compiler
  root. Its owning frontend project also passes typechecking.
- Include the new JSON-response tests and a strict API typecheck in the assisted
  regression runner. Do not claim the entire runner was executed this turn.

## Runtime regression found and repaired

The compliance-count fixture marked a candidate erased before inserting that
candidate's historical applications. The database correctly rejected those
writes with `candidate_erased`.

Seed all historical activity, including reporting extensions, before applying
the erasure and do-not-contact flags. No trigger, privacy policy, application
guard, or count predicate was relaxed. Removed obsolete session `jobId` fixture
properties absent from the native database schema.

## Verification

- Full API strict typecheck, including tests: pass, zero diagnostics.
- Frontend typecheck: pass.
- Initial sequential run: 194 passing markers retained; seven compliance cases
  had a setup failure; the outer budget interrupted the workflow suite.
- Corrected compliance-count fixture: 7/7 pass.
- Remaining workflow journey cases: 19/19 pass; together with the first run,
  all 57 top-level journey cases are covered.
- Reporting extension consuming the corrected fixture: 10/10 pass.
- JSON-response helper regressions: 4/4 pass.
- Bounded batch/shard planner: 9/9 pass.
- Scoped ESLint: zero errors; three existing warnings.

Only unfinished checks and the repaired failing fixture were rerun. Existing
formatting issues were not broadly reformatted; new formatting issues were
corrected in previously clean files. Subsequent formatting changes are
whitespace-only.

Tests used the egress guard, mocked transports, and disposable schemas or
uniquely prefixed test records. This was not a new live-provider test, email send,
candidate interview, identity verification, or production acceptance exercise.

Application services were left running: these changes do not require an
application restart.
