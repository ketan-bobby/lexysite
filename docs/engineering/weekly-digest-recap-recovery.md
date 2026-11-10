# Weekly candidate recap recovery

Implemented in development on November 10, 2026, after the original IT handover
snapshot. This is an additional backend reliability change, not live provider or
production sign-off. The previously downloaded pack remains a dated snapshot.

## Behavior

- Each new bound weekly email records its reporting date and a checksum of the
  candidate ID, owning tenant, recipient address and portal account in its
  operation ID. The checksum is not an authorization token.
- After provider acceptance is durably saved, the scheduler creates a private
  bell notification using that receipt. Its deterministic ID prevents duplicate
  notifications and preserves read state on retry.
- Every normal weekly scheduler tick first recovers missed bell entries, even
  when the email cadence prevents another send. Processing is bounded to 100
  eligible receipts per tick, with further entries eligible on later ticks.
- Recovery has no email or AI-provider dependency. It creates a dated generic
  recap rather than inventing or recomputing historic learning metrics.
- Accepted send timestamps and counts do not increase during recovery.
- A failed recovery pass does not stop ordinary digest processing. An individual
  failed write remains eligible for a later tick.

## Safety boundaries

Both selection and atomic insertion require an accepted email receipt (sent,
delivered or opened, with a saved acceptance timestamp), the
platform partition, the current platform-pool candidate, matching identity,
no erasure and no DNC flag. Changed owner, portal account, email or pool prevents
recovery. Existing ownership checks on the candidate's notification API remain
unchanged. No private learning snapshot is added to the communication ledger.

Pending/uncertain, rejected, simulated, suppressed and legacy unbound receipts
are not backfilled. In particular, this is not an uncertainty-release mechanism
and never authorizes a resend. Old receipts cannot establish the original
account binding and may already have a randomly keyed notification.

The existing notification table is reused. No database migration, deployment
configuration, scheduler enablement, commercial limit, model, prompt or provider
routing change is needed. PostgreSQL's built-in SHA-256 and JSON functions compare
the identity at insertion; no extension or credential is introduced.

## Verification

The focused suite covers actual development-database acceptance receipts with
mocked mail transport: notification failure/recovery, mirror timestamp changes,
Unicode/quoted identity serialization, six concurrent inserts, read-state
preservation, cooldown, invalid outcomes, stale accounts/tenants/addresses,
pool changes, DNC, erasure, legacy receipts and foreign receipt partitions.
Scheduler-source checks ensure recovery precedes email eligibility selection.

```sh
pnpm --filter @workspace/api-server exec node \
  --import ../../scripts/test-egress-guard.mjs --import tsx \
  --test --test-concurrency=1 --test-force-exit \
  src/lib/weekly-digest-recap.test.ts src/lib/scheduler-mail-handover.test.ts \
  src/lib/cadenced-communication.test.ts
```

The new regression file is registered in the canonical assisted baseline.
The existing development-table erasure trigger was checked in the live catalog;
it is installed and enabled for ordinary writes (`tgenabled = O`).
this module does not replace that database write barrier with an application-only
visibility check. Production protections were not inspected.
Fixtures use synthetic identities, explicit owned-record cleanup and blocked
provider egress; they never call the unscoped recovery scan.

For IT acceptance, simulate a failed bell write after an accepted dummy email,
then run a **record-scoped** recovery. Confirm one dated bell entry, no additional
email, unchanged cadence and preserved read state on replay. Do not edit a real
candidate or reset an uncertain receipt to manufacture a test.

### Measured development closeout

- 50 focused email/recap regression tests passed with provider egress blocked.
- Strict API typecheck, compiled build and all existing security/build guards passed.
- Root lint had zero errors (521 pre-existing warnings); formatting passed.
- The API was restarted after the final runtime change; health returned HTTP 200.
- Login rendering was checked. No new browser acceptance or live-provider result
  is claimed, and the earlier full combined gate was not rerun for this change.
