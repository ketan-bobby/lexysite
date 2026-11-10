# Backend record fields — 2026-10-11

## Corrected

- Career campaign status selects candidate `currentTitle` and `currentCompany`
  through the existing `jobTitle`/`company` response aliases. Tenant predicates,
  recruiter ownership checks, result limit and static-route order are unchanged.
- Candidate research recommendations resolve employer names from the tenants
  owning the candidate's applied jobs. The nonexistent `jobs.company` projection
  is removed. One bounded join replaces per-job reads; candidate/application
  scope and existing recommendation/completion behavior are retained.
- Optional hiring-manager decision notification resolves the package creator's
  canonical user name, using its first word for the greeting. Missing names keep
  the neutral greeting; HTML escaping and non-fatal mail handling remain intact.
  No decision, approval, send authority or inbox write was changed.

## Verification

- The expanded offline regression command passed all 24 tests, including four
  new checks over current source queries/notification bodies.
- Substituted DB/mail checks assert real stored-field projections, stable
  response aliases, retained null/empty/explicit tenant predicates, bounded
  applied-job filtering, correct employer join, creator recipient lookup,
  safe greeting fallback/escaping and non-fatal mail failure.
- These are source-body/query-contract regressions, not live SQL execution,
  actual mail delivery or full authenticated browser acceptance.
- Production-only matched compiler scope: **410 → 406** diagnostics, four
  resolved and zero added. An intermediate duplicate import was removed before
  final verification; no strictness or baseline exclusions were changed.
- Changed-source lint: zero errors, nine existing warnings. New test formatting
  and whitespace checks passed.
- Managed API restarted once after the code batch. Build, privacy/security,
  rubric and prompt guards passed. Public Lexy sign-in screenshot renders.

Models, generation parameters, prompts, providers, rubrics, human approvals,
free pilot access and external sourcing are unchanged. No candidate mail or
paid AI request was initiated. Existing dormant-Stripe administrator alerting
ran on API restart; billing settings were not changed.

## Separate privacy work identified

The inspection also found nonexistent interview relationship columns in
candidate data-export and erasure paths. Those paths were not edited or invoked
in this batch. Summaries are linked by `interviewSessionId`; schedules by
`applicationId`, not session ID. Dedicated fixes must preserve existing
authorization, retention and candidate/employer evidence boundaries and use
disposable fixtures to prove completeness, isolation and failure behavior.
No real candidate was exported or deleted for this inspection.
