# Candidate-field and Talent Match cleanup

## Result

API compiler diagnostics: **174 → 161**, 13 removed and zero new.
Remaining: 60 application/script diagnostics and 101 test diagnostics.
The full typecheck still fails; this is a focused cleanup, not full acceptance
of the six-stage autonomous workflow.

## Changes

- Application pipeline cards expose the canonical `githubUrl` under the existing
  `githubProfile` response key used by the frontend menu.
- Applications have no `nextBestAction` column. Their initial recommendation is
  null; the existing job-scoped intelligence overlay still supplies the action.
  No recommendation, scoring rule or workflow decision was changed.
- Talent Match selects retain native Drizzle column types rather than casting
  column objects to nullable scalar values. The merged response has an explicit
  nullable result contract. Existing source precedence and sorting are unchanged.
- Client snapshot inserts explicitly leave unsupported experience/work-style/
  language fields null. Those fields do not exist on the canonical candidate
  row; private career/intake information must not be substituted. The existing
  approved-introduction, privacy and staff/ownership gates are unchanged.

## Evidence

- **12 HTTP/database regression checks passed** for pipeline, Talent Match,
  cross-tenant intelligence, private-development access and introduction
  approval/edit/withdrawal. Disposable fixture tenants only; no provider calls.
- **Eight query/controller contract checks passed**, including a new check
  executing the current client snapshot SQL template with deliberately unexpected
  private values. It verifies explicit nulls and exclusion of those values;
  that SQL-template check does not execute a live client submission.
- API build and security guards passed.
- Managed API restart succeeded and the login preview rendered normally.
  The pre-existing dormant-Stripe configuration alert remains unchanged.
- Scoped source/test lint passed with zero errors; grandfathered warnings remain.
- All four AI calls in the edited candidate/Talent Match routes are byte-for-byte
  unchanged against the checkpoint. No model, prompt, routing, access, pricing,
  or historical Linx data changes were made.

Logs: `/tmp/api-candidate-fields-final.log`,
`/tmp/candidate-fields-regressions.log`,
`/tmp/candidate-snapshot-contracts.log`, `/tmp/candidate-fields-build.log`,
`/tmp/candidate-fields-lint.log`, `/tmp/candidate-fields-test-lint.log`.

## Subsequent caller repair

This pass left the natural-language candidate search's object-valued
system-prompt argument unchanged pending approval. The user subsequently
approved fixing that request only; see
[the separate repair record](candidate-nl-search-request-fix-2026-10-11.md).
The main prompt, models and provider routing remain unchanged.
