# Campaign process recovery — development verification

This addendum extends the existing Zoho campaign regression. It does not change
production dispatch behavior, database schemas, approval requirements or models.
It is not a live-provider acceptance or production-capacity report.

## What was already covered

The synthetic campaign journey already exercised duplicate campaign creation,
approval and cancellation, uncertain and simulated delivery, current privacy and
authority checks, stale-attempt recovery, and a bounded queue of 16 recipients
processed by eight concurrent calls across three waves.

Those concurrent calls shared a Node process. Recreating an object or seeding a
stale row was not evidence of recovery after an actual worker process was killed.

## Added checks

- **Kill during candidate lookup:** the committed `preparing` claim survives;
  no interview session or delivery acceptance is fabricated.
- **Restart while the attempt is fresh:** a separate process does not reclaim
  it or send an invitation.
- **Expire only the fixture attempt:** advancing its timestamp past the existing
  ten-minute threshold moves it to `review_required` with `interrupted_attempt`,
  without sending.
- **Kill inside the fake sender:** the committed `sending` claim and session
  survive. Provider acceptance remains unknown; invitation timestamp stays empty.
- **Restart after recovery:** the held attempt is not resent or requeued.
- **Race two independent workers:** one queued recipient produces one processing
  result and one fake send.
- **Restart after committed fake acceptance:** the original message reference,
  session and invitation timestamp remain; no second send occurs.

Two owned worker processes are deliberately terminated with `SIGKILL`.
Other workers close their database pool and exit cleanly. Parent cleanup waits
for owned children before deleting fixture records.

Timing output now separates the original bounded contention/replay measurements
from child-process startup and recovery time.

## Isolation

- Parent and children verify the local development database identity before
  fixture access. No production database is queried.
- All records belong to a randomly named synthetic tenant. Campaigns use the
  existing `isolated_test` lane, which the production dispatcher does not claim.
- Workers inject the actor, source, message context and fake sender.
- External HTTP is denied by the existing test egress guard.
- Workers import the dispatcher, not the API bootstrap; they start no application
  server or schedulers.
- No candidate email, Zoho request, Greenhouse write or real delivery occurs.
- No database restart, host failure, actual provider acceptance or production
  throughput is proved. The `sending` crash checkpoint enters a fake sender but
  intentionally does not obtain an acceptance receipt.

## Repeatable verification

Verified on November 14, 2026: **7/7 focused tests passed**, with no skipped or
cancelled tests. API typecheck, targeted formatting and whitespace checks passed.
The bounded queue produced 16 fake sends for 16 recipients. The added process
checks completed two forced terminations and retained the expected durable
states. No production application code was changed.

From the repository root:

```sh
pnpm --filter @workspace/api-server exec node \
  --import ../../scripts/test-egress-guard.mjs \
  --import tsx --test --experimental-test-module-mocks \
  --test-concurrency=1 --test-force-exit \
  src/lib/ats-connectors/zoho-interview-campaigns.test.ts \
  src/lib/ats-connectors/zoho-campaign-delivery-evidence.test.ts \
  src/lib/ats-connectors/zoho-campaign-reviews.test.ts
```

The expanded journey remains in the existing assisted-baseline manifest; no new
optional-only check is needed. This focused run does not replace the dated
[consolidated acceptance report](consolidated-development-acceptance-2026-11-14.md)
or imply that the entire baseline was rerun.

## Team handover boundary

These independent local reliability checks no longer need team involvement.
The team still needs to verify deployment prerequisites and authorized live
provider behavior. Do not use this fixture as approval to send invitations or
to automatically retry an uncertain real delivery.
