# Native assessment pilot acceptance — 2026-10-08

## Real provider check

- One real call through the unchanged native screening agent and configured AI client.
- Synthetic professional profile; private database fixture and fictional staff authorization.
- Result: score **65**, recommendation **hold**.
- One provider request; zero blocked/unapproved HTTP attempts.
- A job-scoped source retained the grade and became ready for review.
- The workflow screening step remained pending before the fixture's explicit review.
- The reviewed fixture then exposed verification as the next step, without activating it.
- No candidate emails, invitations, speech calls, external sourcing or real LinkedIn lookups.
- Temporary records were removed with the private fixture. Older Linx records were not changed.

This proves the native screening provider/result/persistence path. It is not proof
of a real staff UI approval, a real candidate's suitability, actual dollar costs,
independent identity verification, or unrestricted six-step autonomous execution.
The real call was performed once, before the final source-creation/read-back
hardening; those additional safeguards were covered by the regression gate,
without repeating a paid request.

## Implementation

- Screening and identity advice have separate, explicit one-hour grants.
- Approval targets the next eligible step only; screening review must come first.
- Older screening grants cannot authorize identity checks.
- Canonical profiles without sourced rows obtain a job-scoped internal snapshot;
  it makes no résumé, external-provider or completed-assessment claim.
- Snapshot creation is serialized to avoid duplicate cards.
- Bound screening rejects malformed grades before scoring writes, propagates
  source-persistence failures, reads its saved result back, and suppresses
  recruiter notification email and unapproved intelligence recomputation.
- Bound identity checks retain the existing model and prompt, but persist only
  validated AI advice as **pending**, with identity unverified.
- Existing identity records are reviewed/resolved, not overwritten or rechecked
  for another charge. Pending advice is not qualifying completion evidence.
- Pause, Cancel, revocation, scope, expiry and natural action claims remain enforced.
- Ordinary assisted actions and external sourcing configuration are unchanged.

## Regression evidence

`pnpm test:assisted-baseline` passed:

- 418 API tests, 50 web-logic tests, 5 egress-guard tests.
- Frontend typecheck, API build and security/ownership guards.
- No ESLint errors; no new formatting violations.

The identity integration test uses controlled AI output and real private fixture
transactions/HTTP authorization. It proves that even a model's “clear / 100” does
not become verified identity, cannot complete verification, cannot repeat the
claimed action, and cannot overwrite an existing record.

## Browser controls

A no-spend browser fixture mounted the production workflow-row and pilot
components with React Query and intercepted all API requests. It confirmed
identity-not-proof/pending copy; inbox and cost-acknowledgement gating; a
verification-specific, normalized activation body; no dispatch on activation;
separate launch availability only after mock activation; inactive/claimed/paused
restrictions; no activation form for non-controllers; and a visible mocked
409 conflict without falsely activating.

This is component-level browser acceptance with mocked APIs, not a real staff
approval or live identity-provider check. The launch control was not clicked.

## Repeatability

The opt-in acceptance intentionally permits at most one configured chat POST.
Do not add it to routine CI or repeat it automatically when a paid outcome is
unknown:

```sh
cd artifacts/api-server
NODE_ENV=test pnpm exec tsx --experimental-test-module-mocks \
  --import ../../scripts/live-screening-egress.mjs \
  --test-name-pattern='one real native screening' \
  src/routes/recruiting-workflow-journey.integration.test.ts \
  --live-screening-acceptance
```

Normal regression runs use the no-live-egress guard and do not register this
opt-in test.
