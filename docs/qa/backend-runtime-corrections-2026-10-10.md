# Backend type diagnostics — focused runtime corrections

## Scope and measurement

The full API typecheck exceeded its 120-second outer deadline without producing
diagnostics. A temporary configuration under `/tmp` then checked production
TypeScript with the existing compiler settings and project references, excluding
test files and resolving the existing Node declarations explicitly.

No committed typecheck configuration, strictness setting or dependency changed.
The measured production scope went from **444 to 437 diagnostics**: seven
removed, none added when comparing file, error code and message independently
of shifted line numbers. Both compiler runs exited nonzero. This is not a clean
backend or full-project typecheck.

## Corrections

- Candidate withdrawal now returns the canonical stage-change helper's result
  instead of referencing an undefined variable after a successful save.
  Ownership checks, terminal-stage restrictions, the stage/audit choke-point,
  governance attestation and outcome capture remain intact.
- Interview invitations and re-engagement now derive canonical candidate names
  from stored first/last name parts. Raw sourced-profile name handling and
  anonymous fallback remain unchanged.
- Removed unused imports of nonexistent AI and intelligence exports.
- Removed a redundant `ok` property preceding the conversation-draft service
  result; the spread already supplied that property, so response semantics
  remain unchanged.

## Verification

`pnpm --filter @workspace/api-server run test:backend-runtime-regressions`
runs seven offline checks with the existing outbound-network guard:

- Three pure name-formatting checks: full, partial and absent names.
- Four checks executing the current withdrawal route body, extracted with the
  TypeScript AST and supplied controlled auth, persistence and side-effect
  substitutes. Cover success, missing/foreign/unauthenticated access, terminal
  stages and failed writes.

All seven passed. These are source-handler/unit checks, not a real database,
browser or live candidate acceptance test. Changed-source lint had zero errors
and twelve existing warnings. Whitespace checks passed.

The managed API was restarted once after the coherent code batch. Its build,
security/privacy checks and frozen-rubric/prompt guards passed, and it is
serving requests. The existing dormant-Stripe startup warning and admin-alert
email ran; billing configuration was not changed.

No models, provider routing, prompts, rubrics, tier limits, identity policy or
hiring decision rules were changed. No live candidate test or paid AI request
was run for this batch.

## Remaining

437 production-scope diagnostics remain, including inherited parameter typing,
record-field mismatches, nullable values and handler return-path issues.
Remaining errors require separate inspection; they are not all classified as
harmless noise. AWS, multilingual human review and real ATS integration remain
outside this cleanup batch.

## Second batch: caller context and record fields

- AI-message scope now derives its caller type from the canonical scope helper,
  including the ID required for recruiter-admin assignment resolution. Runtime
  forwarding remains unchanged; the full caller object was already supplied.
- Interview invitations resolve the employer name from the job-owning tenant
  rather than a nonexistent job column. Missing names retain the existing
  neutral wording. Controlled/unbound link routing is unchanged.
- Internal-source ID restoration checks for the internal-only metadata field
  rather than assuming external profiles contain it; existing fallback remains.
- Optional similar-hire enrichment requires a resolved tenant, matching the
  existing intelligence-write guard. Successful job-derived resolution still
  feeds and enriches as before.

Five additional offline source-body regression tests passed, alongside the
previous seven (12 total). Coverage includes captured invitation payloads,
employer lookup predicate and fallback, controlled link routing, caller object
forwarding, internal canonical ID restoration, and unresolved/resolved tenant
enrichment. Mail, DB and provider operations were substituted; this is not a
live delivery, real database isolation or paid-provider acceptance test.

Changed-source ESLint: zero errors, five existing warnings. New test formatting
and whitespace checks passed. The matched production-only compiler scope
completed with 432 diagnostics, down from the previously recorded 437. The five
targeted diagnostics are absent; the full backend remains non-green.

Compiler attempts initially timed out/interrupted alongside resident heavy
processes; the development container restarted, losing temporary diagnostics.
The compiler completed after that interruption with the same production-only
configuration restored and no other heavy workload active. API and Lexy web
services were then restored. The API build gates passed and a screenshot
confirmed the public sign-in page renders. Existing dormant-Stripe alerting ran
on startup; this batch initiated no candidate mail, interview or paid AI call.

Models, prompts, provider routing, rubrics, pilot entitlements, approvals and
hiring policy are unchanged. Remaining diagnostic count is not a claim that
the remaining issues are harmless or that all autonomous stages are proven.
