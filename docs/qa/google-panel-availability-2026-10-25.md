# Google panel availability — 2026-10-25

## Passed

- **169 backend checks**, including Google/Outlook invitation and change
  regressions, candidate Meet projection, shared slot calculations and 14 new
  Google panel orchestration/transport/HTTP checks.
- **Five real PostgreSQL metadata checks** on the explicitly confirmed
  development handle: valid private storage, missing table, PUBLIC column grant,
  exposed policy and missing FORCE RLS. Fixtures used a private rollback-only
  namespace; independent cleanup confirmed it did not escape the transaction.
  The actual development sharing/grant tables also passed privacy readiness.
- **20 initial real-component browser scenarios**, followed by focused consent
  corrections: server-provided revision for first enable, null/malformed
  revision blocking mutation, and withdrawal with an unhealthy connection.
  The complete expanded browser suite was not rerun after these focused changes.
- API/frontend strict typechecks and generated shared-library build.

Backend cases include every-member grant identity/tenant/status/erasure/role
checks, separate consent, stale native versions, changed grant/consent after
refresh, buffers, working hours, unknown and partial failures, primary-calendar
restriction, malformed Google replies, minimal output, explicit enable
acknowledgement, caller/body gates and private-safe HTTP errors.

The HTTP cases inject synthetic identities/repositories. They are not a full
signed-in middleware/RLS application test. SQL checks prove catalog rejection,
not the complete real-account search transaction.

The UI uses actual components, AuthProvider and generated clients with mocked
network. It covers staff/candidate/interviewer gating, malformed/unknown
responses, input and directory staleness, role changes, expiry guards, native
draft callback without writes and a 360px viewport. The native dialog's distinct
suggested-start seeding was confirmed from source/typecheck, not by a new
full-page browser journey.

## Commands

```sh
pnpm --filter @workspace/api-server run test:google-panel
pnpm --filter @workspace/lexy run test:google-panel-browser
pnpm --filter @workspace/api-server run check:google-panel-sql <confirmed-development-fingerprint>
```

Unit and browser suites are registered in the assisted baseline. The explicit
development-fingerprint SQL check is deliberately not an automatic baseline
write. No full assisted-baseline pass is claimed.

## Release boundary

Migration 0089 was applied in development only. Production rollout/privacy and
consenting real Google-account acceptance remain pending. No real provider
calendar operation, candidate message, model/prompt/routing change, billing
change or production write was performed. Existing service restart jobs may
run maintenance and billing-configuration alerts.

This unit is Google-only common-time search. Saving Google/mixed-provider panel
rosters and issuing panel invitations are not implemented by it.
