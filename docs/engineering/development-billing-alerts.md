# Development billing-alert isolation

The Stripe dormancy sentinel still detects an unexpected configured Stripe key
without acknowledgement. Startup/hourly error logs and startup/daily in-app
platform-admin notifications remain enabled.

Only external **sentinel alert email** is isolated:

- `NODE_ENV=production` preserves the existing public-address notification flow.
- Development, tests, staging, missing or unrecognized environments do not send
  sentinel emails. The log records the suppression; the in-app warning remains.
- The running server has no development recipient-override setting. An isolated
  test harness may inject an exact recipient allowlist and a fake sender.
  Wildcards do not match; invalid/reserved addresses remain blocked even when
  explicitly listed.
- Suppressed email does not initialize the email-provider module.
- Attempt counts mean attempted delivery, not accepted delivery or inbox receipt.

This does not alter checkout gates, Stripe keys or acknowledgement flags,
complimentary Enterprise access, subscription tiers, fee-ledger behavior, normal
candidate/staff messaging, production settings, or production databases.
Production hosts must identify themselves explicitly with `NODE_ENV=production`
to retain sentinel email escalation. No hosting configuration was changed here.

## Isolated regression checks

```sh
pnpm --filter @workspace/api-server exec tsx \
  --import ../../scripts/test-egress-guard.mjs \
  --test src/lib/stripe-sentinel-escalation.test.ts
```

The suite imports neither the server bootstrap nor the real email provider.
It uses in-memory delivery spies for development/unknown environments, production
policy, exact test authorization, reserved addresses, failures and repeated
development restarts. No real recipient is contacted by these checks.
