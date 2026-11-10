# Role and outreach field cleanup

## Scope

- Preserve named-route parameter inference through `resolveUser` and
  `requireRole`. Runtime authentication and role checks are unchanged.
- Fail missing-subject scheduled messages through the existing failed-send
  path before transport preparation. Valid messages and enrollment counters
  are unchanged.
- Persist approved conversation reply approver identity in supported email
  audit metadata rather than an unsupported, ignored top-level field.

No models, prompts, provider routing, pricing, sourcing availability or
historical Linx data were changed.

## Verification

- Full API compiler: **342 → 250 diagnostics**, 92 removed, zero added.
  The full typecheck is still not clean.
- **131 regression checks passed**, including private-database role checks,
  ownership regressions, all 57 top-level workflow-journey checks and their
  seven child checks. The first broad shell invocation timed out after 110
  completed checks; its 21 remaining checks passed in a separate invocation.
  Completed checks were not rerun.
- Added real HTTP tests for named IDs, anonymous access, authoritative
  database roles versus JWT role claims, and suspended-user rejection.
- Added private-database checks for missing-subject failure without enrollment
  advancement and durable approver audit metadata under demo-domain transport
  suppression. These are not evidence of live email delivery.
- Scoped ESLint: zero errors, eight existing warnings.
- API build and its existing security guards passed.
- Managed API restart succeeded and the public login preview rendered normally.
  The pre-existing dormant-Stripe configuration alert remains unchanged.

Evidence: `/tmp/api-role-fields-final.log`,
`/tmp/role-fields-regression-final.log`,
`/tmp/role-fields-remaining-tests.log`, `/tmp/role-fields-lint.log`,
`/tmp/role-fields-build.log`.
