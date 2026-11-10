# Native workflow customer-isolation regression

## Implemented coverage

Added a reusable HTTP isolation matrix to the existing disposable six-stage
workflow integration harness. It uses three fictional job/candidate/workflow
sets: two jobs in one customer and a job in another customer.

Checks cover:

- Anonymous, candidate-role, and foreign-customer denial for state/shadow reads,
  follow-up reads, pause controls, execution requests, and evidence requests
  for all six step keys.
- Cross-customer denial in both directions.
- Foreign-parent responses matching nonexistent-parent responses.
- Same-customer wrong-job and foreign-customer child workflow IDs matching
  nonexistent-child responses.
- Rejection of enrollment using another job's journey or unlinked candidate.
- Denied responses not exposing candidate/workflow identifiers.
- Authorized state/shadow/follow-up reads not containing another fixture's
  candidate/workflow identifiers.
- Both customers retaining successful reads and legitimate pause controls.
- Signed token role/tenant claims not overriding the actual account's role or
  customer: a foreign admin cannot become a platform admin, and a candidate
  cannot become staff by changing those claims.

The matrix performs **95 rejected-request checks**, plus **two forged-claim
checks**. Before/after comparisons cover full persisted rows in 13 private
tables, not just record counts. Rejected actions do not change jobs, candidates,
applications, journeys, workflows, events, receipts, audits, AI jobs, outreach
messages, interview plans/sessions, or vendor usage attempts.

The shared fixture retains its original default customer behavior and can now
create a legitimate second-customer case. Assertions live in a focused helper
instead of adding the entire matrix to the already-large journey test file.
Snapshot reads are sequential on the fixture's single PostgreSQL client.

## Verification

- Initial targeted matrix plus existing six-step source/human-authority journey:
  nine reported tests passed.
- Expanded final matrix, including reverse-direction and authorized-read leak
  assertions: passed in a focused continuation.
- Full API strict typecheck: pass.
- Changed-file ESLint: pass with no reported findings.
- Changed-file Prettier check and patch whitespace check: pass.

The existing assisted baseline automatically discovers/shards the journey file's
top-level test names, so the new matrix is included in future baseline runs.
The entire broader baseline was not rerun merely to duplicate retained results.
Its earlier formatting-only historical failure remains a separate receipt.

## Scope and boundaries

This is genuine HTTP authorization/persistence regression coverage with fictional
data, not a fresh live six-stage acceptance run or whole-product security audit.
The harness uses private disposable tables and denies external provider egress.
Separate offer, storage, other API, and database-RLS evidence remains separate.

No production authorization change was needed: the tested guards passed.
No model, provider, prompt, entitlement, billing guard, invitation, offer,
historical Linx work order, or actual candidate was changed. No app workflow
restart is needed for test-only source changes.

Team language ratings remain pending. AWS-dependent acceptance and an authorized
external ATS connection remain deferred.
