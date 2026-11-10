# Candidate data-export correction — 2026-10-11

## Scope

Corrected GET `/portal/me/export` only. Candidate erasure remains separate,
queued work; no DELETE or DNC purge handler was changed or invoked.

Schedules now join to the candidate's exported applications by `applicationId`,
with explicit candidate ownership, bounded application IDs and matching
schedule/application tenant predicates. This includes human schedules when no
AI session exists, rather than querying a nonexistent schedule `sessionId`.

Schedule recruiter notes are redacted; feedback rating is null and feedback
notes are withheld. Existing session answer/assessment/binding-secret and
application-note redaction is preserved. The download schema version, attachment
headers and successful `no-store` behavior remain intact. Failures return a
generic 500, not a partial download or raw database error detail.

## Verification

`pnpm --filter @workspace/api-server run test:candidate-data-export`
passed five database-backed HTTP checks using fresh disposable fixtures:

1. Human schedule exports without any session, with privacy redactions and
   JSON attachment/no-store headers.
2. Same-tenant and independent foreign-tenant candidates have positive own-row
   exports; neither sees the other's schedules. A schedule with an inconsistent
   tenant is excluded. Caller-supplied candidate/application IDs do not redirect
   an export to another subject.
3. Actual recorded session retains the candidate's words, while removing
   answer grades/feedback, overall score and binding secret.
4. Empty exports succeed; tokenless/unlinked users and erased subjects are
   rejected.
5. Injected read failure returns generic 500 without attachment or internal
   error detail.

The harness extracts the current controller from source, uses the real shared
candidate resolver and tenant middleware, and executes SQL against real fixture
rows. It injects the admin DB handle deliberately so SQL ownership predicates
must work without relying on RLS to hide foreign rows. Dynamic schema loading
uses the actual table exports; logging/auditing is substituted. This does not
certify the full router/import stack, audit persistence or production RLS.

All fixture deletion is strictly bounded to freshly generated fixture IDs. No
real candidate data was exported/erased, no schema migrations were run, and
the preload blocked outbound HTTP outside this local harness.

The prior 24 offline backend regressions also passed. Changed-source lint had
zero errors and five existing warnings. Test formatting/whitespace checks
passed. API build/security/rubric/prompt guards passed; managed API and web are
running, with public sign-in preview verified.

No new portal download button was added; this is a correction to the existing
backend download endpoint. No full backend typecheck result is claimed.
Models, prompts, providers, human approval controls, free pilot access and
historical Linx records are unchanged. Existing dormant-Stripe administrator
alerting ran during API startup; no candidate messages were initiated.
