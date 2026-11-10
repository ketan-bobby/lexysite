# Password-confirmed all-device sign-out — development evidence

## Implemented

Staff personal Settings and candidate Account Settings now contain **Sign out
all devices**. It requires the current local password and explicit acknowledgement.
Success invalidates all previously issued account sessions, including the caller,
without changing the password. Ordinary sign-out remains session-specific.

`POST /api/auth/logout-all` takes only `password` and `acknowledge: true`. The
subject is resolved from the signed current session, never a client-supplied
account ID. A locked account, stale epoch, suspended/erased identity, wrong
password or missing acknowledgement cannot rotate the epoch. Confirmation has
per-IP and per-account limits. These rate-limit counters are process-local,
not a distributed brute-force budget.

A row lock serializes account credential changes and all-device actions. Epoch
rotation and `auth.sessions_revoked` audit insertion share one database
transaction. Audit failure rolls both back. Authentication audit evidence is
platform/control-plane scoped, not employer-visible recruiting activity; it
contains no password, hash, token or epoch.

The UI clears the entered password and acknowledgement after submission,
preserves the current session on confirmation/storage errors, and does not
retain password-bearing mutation variables in React Query or browser storage.
An identity switch clears confirmation and prevents a delayed old-owner
response from signing out the newly displayed identity.

## Verification

- API and web typechecks passed after rebuilding generated shared declarations.
- Ten targeted unit/regression checks passed, including four new service checks:
  confirmation, account gates, credential-free audit and audit-failure rollback.
- Native development-only integration: **five independent API processes, three
  replacements/restarts, 86 protected cookie/bearer checks**, two actual password
  reset flows with simulated notification transport. All-device checks include
  wrong password, missing acknowledgement, missing session, real SQL rollback
  after audit failure, cross-replica and post-restart old-session rejection,
  an unrelated-account control, unchanged password/fresh login and HTTP 429.
- New guarded browser regression passed two scenarios: confirmation/error/retry
  and successful teardown; switched-identity stale-response safety.
- Existing browser regression passed ordinary logout/retry and manual handoff
  controls. UI tests use the actual components with synthetic API responses;
  they are not live provider or full signed-in deployment acceptance.

Commands:

```sh
pnpm --filter @workspace/api-server exec node --import ../../scripts/test-egress-guard.mjs --import tsx --test src/lib/logout-all-sessions.test.ts src/lib/credential-session-version.test.ts src/middlewares/sessionRevocation.test.ts
pnpm run test:session-replicas --development-fingerprint=YOUR_VERIFIED_DEVELOPMENT_FINGERPRINT
pnpm --filter @workspace/lexy run test:logout-all-browser
pnpm --filter @workspace/lexy run test:session-handoff-browser
```

The native harness verifies the development database fingerprint, refuses
provider egress, never starts scheduler/bootstrap jobs and cleans up only its
journal-owned fixture. Real candidates and production were not used.

## Team deployment and limitations

Apply **0113 → 0114 → 0115** to the identity/control database before coordinated
replacement of every API replica. Quiesce session issuance and password changes
during mixed-version cutover. Migration 0115 adds an explicit server-generated
epoch-rotation request to the existing trigger; restoring an arbitrary earlier
epoch is still ignored. Missing/incompatible schema fails closed. Do not use
Drizzle push or startup DDL to replace reviewed migrations.

Only development was migrated. Team/manual acceptance remains **Not Run**.
Organization-only SSO accounts without a local bcrypt password receive an
explicit unsupported-confirmation response; there is no insecure bypass.
Fresh Microsoft reauthentication is a separate extension, not proven here.
This action does not revoke external provider OAuth grants, cancel already
authorized work, or invalidate independently issued interview/upload links.
Already expired sessions remain expired. A lost success response can leave the
browser unsure whether revocation committed; the UI advises retry/sign-in
rather than promising that sessions remained active.
