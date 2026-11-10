# Backend source hardening

## Result

The full API compiler went from **153 diagnostics to 101**. All 52 remaining
non-test application/script diagnostics are resolved; the 101 remaining
diagnostics are in existing test fixtures. The full API typecheck therefore
still exits unsuccessfully. No compiler exclusions or weaker settings were used.

Lexy's frontend typecheck passes.

## Functional corrections

- Candidate-to-job links normalize free-text sources such as `cv_upload` into
  the supported sourced-row category. Original source, scoring tenant and
  recruiter-origin inputs are preserved. No historical links were backfilled.
- Manual candidate emails use the supported `follow_up` communication category
  rather than the invalid `message` enum. The existing human sender, mailbox
  dispatch, sent status and message body are unchanged.
- Unsupported application stages fail before either stage mirror or its audit
  trail changes. Validation is inside the application branch; sourced-only
  custom stages remain supported.
- S3 prefix cleanup accounts for per-object errors in successful HTTP responses
  and incomplete pagination. These return incomplete cleanup, not false success.
  Quiet responses without a successful-object list remain valid.
- Live pilot scripts validate returned session/run identifiers and status while
  retaining additional evidence. The scripts were not executed against providers.

## Type-only/behavior-preserving corrections

- Twenty-one Express callbacks across eight route modules send the same replies
  and stop the same branches, but resolve `Promise<void>`. Their edits were checked
  against the reviewed return-only transformation.
- LINX terminal IDs have literal route parameter types. Membership role filters
  retain their original enum literals instead of casting them to arbitrary text.
- Password hashing is typed after the existing password-strength validator.
  Password policy and public response behavior were not changed.
- Billing provisioning validates its region against the existing database enum.
  Null still defaults to `us`; invalid values remain rejected. No billing
  activation, pilot entitlement, price or payment configuration was changed.
- Outreach retains the workflow-owned draft early return; an unreachable later
  workflow regeneration branch was removed. Model-call arguments are unchanged.
- The shared recording helper describes only its recorder checkpoint interface.
  Its emitted JavaScript is unchanged, excluding comments and whitespace.

## Verification

- 17 source/write/storage/stage regression checks passed.
- The broader regression pass ran 122 checks: 121 passed, one source-location
  assertion failed because cleanup had moved to the durable worker. That check
  was updated to verify collection, durable staging, prefix deletion and worker
  failure handling rather than inline deletion in the old route.
  Its targeted rerun passed; the other 121 checks measured unchanged behavior.
- The new unsupported-stage SQL regression passed without stage/audit mutation.
- Nine test-runner planner checks passed.
- Scoped lint has no errors; existing warnings remain.
- Shared AI configuration is untouched. Outreach generation arguments and
  recording runtime output were compared with the baseline.
- Total: 140 targeted checks passed, plus nine runner-planner checks.
- API and frontend were each restarted once after the coherent changes. The API
  build/guard commands passed, both workflows serve, and the unsigned login
  preview renders normally.
- The existing dormant-Stripe configuration alert remains unchanged. This is
  not a clean production readiness claim or a billing activation.

SDK/controller doubles and isolated SQL checks do not prove live S3 cleanup,
production privileges, delivery to an inbox or production readiness. These
changes do not require another candidate interview.

## Remaining work

Existing fixture-only compiler diagnostics remain. Previously deferred live AWS
acceptance, external ATS access and human pilot reviews remain separate work;
this source cleanup does not claim those are complete.
