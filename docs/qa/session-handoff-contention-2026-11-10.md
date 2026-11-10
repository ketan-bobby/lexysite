# Development closeout: session revocation, manual handoff and queue contention

**Subsequent increment:** the password-change and multi-process limitations in
this earlier report are closed by
`credential-session-replica-verification-2026-11-10.md`. Other scope limitations
and the recorded test results below remain historical evidence.

This report supersedes the earlier statement that logout only clears a cookie.
Production was not accessed, migrated or deployed. Stabilized AI models,
prompts, providers, routing and commercial/pilot settings were not changed.

## 1. Session-specific server revocation

- Every newly issued session has an independent nonce. Logout persists a SHA-256
  fingerprint of the selected signed credential before clearing its cookie.
  Raw credentials and identity details are not stored in the revocation table.
- The common HTTP API guard checks the shared identity/control database for both
  cookie and bearer requests before route/RLS authorization. There is no
  positive-validity cache. A lookup failure returns 503, not authorized access.
- Logout is idempotent. A persistence failure returns 503 without claiming
  success; explicit UI logout shows a retryable error and retains the DEV bearer
  until the request has been sent and confirmed. Automatic already-unauthorized
  teardown can still leave the page.
- Other independent logins for the same account remain valid. Existing signed
  pre-nonce credentials are supported and revocable by fingerprint; historically
  identical credential strings cannot be distinguished as separate sessions.
- Expired rows are removed transactionally on subsequent logouts. Signed session
  verification still checks expiry and fresh account/role authority.
- This fences requests arriving after completed logout. It does not cancel work
  already authorized/in flight, revoke every account session on password reset,
  or provide a device/session-management UI. Explicit development legacy demo
  credentials are not production sessions and must use normal login for logout.

### Migration and external deployment

`lib/db/drizzle/0113_session_revocations.sql` was applied **only to the verified
development database**. The application/control handle fingerprint matched the
independent development SQL target.
The pack includes the reviewed SQL as `Session-Revocation-Migration.sql`.

Your deployment team must review/apply that migration to the production
**identity/control database before deploying this build**, preserving access for
the existing privileged control connection. Do not use a broad Drizzle push:
the project has existing RLS/security layers. No startup-time DDL or automatic
production migration was introduced. Deploy schema first, then all API replicas
and frontend; an old API replica does not enforce the new guard.

## 2. Local employer-owned offer handoff

The existing employer routing, approved human decision, approved work order,
current workflow/assessment snapshot, mapping and actor checks remain intact.
There is no autonomous offer or new HR role.

The owner-authorized handoff panel now records a **human-reported manual
handoff** after the exact packet has been approved and exported:

- Explicit acknowledgement and a bounded non-sensitive case reference are
  required. URLs, email-shaped references and free-form messages are rejected.
- Packet ID/hash, workflow revision, ownership and current evidence are rechecked
  atomically. Repeating the same request is idempotent; another acknowledgement
  for an already recorded packet is rejected.
- The receipt records actor/time/reference with `human_reported_only` status.
  It is not a Greenhouse/Zoho receipt, terms approval, delivery, employment or
  fee evidence. No provider call, native offer send or external write occurs.
- New snapshots do not inherit old handoff receipts. Prior packets retain their
  history. Authority loss clears the form; failed reads hide cached controls.
- The UI displays the local record after refresh/reload through the generated
  API contract. Greenhouse live integration/acceptance remains separate.

## 3. Targeted local contention and recovery

The existing synthetic SQL-backed Zoho campaign journey now exercises:

- 16 distinct recipients, eight concurrent workers, three claim waves.
- Exactly 16 synthetic delivery attempts and 16 distinct interview sessions.
- Eight additional empty-queue worker retries with no further delivery attempt.
- Interrupted/uncertain delivery remains held for review; it is not reclaimed.
- The fixture-only dispatch lane, injected source/delivery/context and network
  guard prevent real provider contact. The live lane cannot claim these rows.

The measured local exercise took approximately **937 ms**, including preparation
and dispatch in that run; the empty-queue replay took approximately **19 ms**.
These are observations from one bounded development exercise, **not throughput,
SLA, production capacity or provider latency guarantees**.

## Verification evidence

- 52 SQL-backed workflow/offer/HTTP checks passed, including packet prerequisites,
  role denial, safe reference, receipt persistence, idempotent replay, duplicate
  refusal, stale evidence and new-snapshot reset.
- Auth-token, revocation-guard, receipt-policy and campaign tests also passed.
  The initial handoff replay assertion exposed a changing fixture revision;
  fixing the fixture to replay the identical request resolved it.
- Native password/cookie tests passed **11 denial scenarios / 33 rejected
  resource requests**, with a successful independent admin control after each.
  Copied logged-out cookies and bearer tokens were rejected. A different login
  for the same account survived; deleting that account then denied its original
  remaining cookie. Original mail holds were retained and owned business
  fixtures were verified removed. Inert revocation fingerprints retain their
  normal expiry; no raw credential is journalled.
- Two repeatable real-browser fixture scenarios passed: actual AuthProvider
  failure/retry/confirmed logout behavior, and manual handoff validation,
  acknowledgement, authority-loss reset and human-reported-only display.
  A testing review caught a fixture no-op setter; it was corrected and the
  affected browser suite passed. These intercepted UI tests do not replace the
  separate native HTTP verification or live ATS acceptance.
- API strict typecheck/build/security guards and frontend strict typecheck
  passed. Both relevant development workflows restarted and served successfully.
- No complete monolithic release regression or production capacity run is
  claimed by these focused results.

## Re-run

```sh
pnpm --filter @workspace/lexy run test:session-handoff-browser
pnpm --filter @workspace/lexy run test:mail-holds-browser
pnpm run test:mail-hold-session-access --development-fingerprint=YOUR_VERIFIED_DEVELOPMENT_FINGERPRINT
pnpm --filter @workspace/api-server exec node --import ../../scripts/test-egress-guard.mjs --import tsx --test --test-concurrency=1 src/lib/auth-token.test.ts src/middlewares/sessionRevocation.test.ts src/lib/ats-handoff-receipt.test.ts src/lib/ats-connectors/zoho-interview-campaigns.test.ts src/routes/recruiting-workflows.test.ts
```

The browser suites are required assisted-baseline groups; new API unit tests are
also registered. Native cookie checks remain fingerprint-guarded and opt-in.
Manual workbook results remain Not Run.

Operational observation: API restart emitted the existing unacknowledged-Stripe-
key sentinel warning and its normal administrator alert. This work did not
enable billing or change secrets. The tests sent no candidate email.
