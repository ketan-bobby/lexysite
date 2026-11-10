# Interview assessment access review — 2026-10-12

## Verified boundaries

Interview summaries are tenantless, uniquely keyed to an interview session.
They cannot be scoped using a nonexistent summary tenant column. Their read
boundary is the session authorised by staff role, current tenant/data scope and
requisition ownership.

The interview list attaches summaries only for its already-filtered session
IDs. The by-id summary endpoint resolves the session and invokes
`staffCanReadInterviewSession` before reading its summary. Recruiter comments
use the same gate before mutation. Read-site markers now identify the
load-bearing parent boundary so a later refactor cannot mistake this for an
unreviewed global read.

The three historical Class-B summary-read tripwires were replaced with
specific reviewed reasons, not removed indiscriminately from the registry.
Other unreviewed Class-B paths remain honestly labelled.

## Completion privacy correction

The candidate capability-authenticated completion endpoint previously returned
the entire stored assessment on its existing-summary fast path. It now returns
only `{ status: "completed", sessionId }`. The queued path still returns
`{ status: "processing", sessionId }`.

This does not grant access to recruiter scores, hiring recommendations, private
notes or evidence. The staff assessment endpoint and stored assessment remain
unchanged. The interview room awaits completion but does not use assessment
fields from that response. Candidate-owned practice/baseline results remain
available through their separately authorised portal paths.

The OpenAPI completion contract previously advertised `InterviewSummary`.
It now describes a completion receipt with required `status` and `sessionId`
fields, with `processing`/`completed` statuses. Typed clients and Zod schemas
were regenerated from the spec; the protected summary contract is unchanged.

## Evidence

- Two independent customer fixtures retain access to their own session and
  assessment; neither list returns the other customer's session or assessment.
- Direct foreign/missing summary requests share the same 404 result.
- Anonymous, candidate-role and same-tenant unassigned recruiter requests
  cannot read the staff assessment.
- Foreign and unassigned recruiter comment updates return 404 and leave the
  stored notes unchanged.
- A real cookie/consent-authenticated HTTP completion with an existing summary
  returns only the completion receipt; its assessment and reviewer note remain
  stored unchanged.
- The focused suites cover 29 checks. The first pass completed 28 successfully
  and caught a test-helper naming typo in the new completion case; after that
  test-only correction, the isolated completion check passed. The earlier
  checks were not needlessly repeated.
- Strict backend typecheck and the Class-B guard pass; scoped lint has zero
  errors (existing warnings remain).
- Shared-library and frontend typechecks pass after regeneration. The
  code-generation consistency check confirms the generated files match the
  OpenAPI source.
- All fixtures are synthetic and cleaned up. The test process is egress-guarded.
- The strict guarded API build and both managed services started successfully
  after the contract update. The public sign-in page rendered normally. The
  pre-existing dormant-Stripe configuration warning remains; billing was not
  activated or otherwise changed.

## Not certified by this review

This is a narrow production-readiness improvement, not blanket certification of
all Class-B exemptions or every candidate journey. Team-led multilingual/audio
acceptance, real identity corroboration, AWS-dependent secure-storage/live
delivery checks and an employer-authorised ATS connection remain separate.
Models, prompts, rubrics, provider routing, free pilot entitlements, offers and
historic Linx work orders were not changed.
