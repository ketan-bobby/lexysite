# Greenhouse offer ledger: committed crash-recovery verification

**Current extension:** nine tests now pass, including process termination after
the committed `draft_created` receipt and recovery of that state after an
immediate PostgreSQL shutdown/WAL restart. Reconstructed controllers retain the
hold; read-only observation cannot request employer approval or repeat creation.
See the [controlled assembly](greenhouse-offer-assembly.md). This remains isolated
fixture proof, not deployment or real-provider acceptance.

Verified in development on 2026-11-14. **Eight tests passed: seven scenarios
plus their parent test.** API type checking and changed-file formatting passed.
No production/application database, customer account, provider or recipient was
used. No application behavior or database schema was changed.

## Repeat the check

```sh
pnpm --filter @workspace/api-server run test:greenhouse-offer-durability
```

This is an explicit opt-in check, not part of the automatic assisted baseline.
It requires `initdb` and `pg_ctl` on PATH and takes about 2–3 minutes here.
Missing PostgreSQL tools fail the check rather than silently skipping it.

The runner initializes its own disposable PostgreSQL cluster under a unique
temporary directory, listens on a private Unix socket only, and enables normal
fsync, full-page writes and synchronous commit. It never inherits the application
database configuration or integration credentials into its worker environment.
Each worker verifies the exact database directory, PostgreSQL system identifier
and invocation ownership marker before writing. Network egress is guarded.

The workers execute the real `greenhouseOfferStore` and
`greenhouseOfferControls` in separate Node processes with independently committed
transactions. Only the authority/configuration source and provider are synthetic.
Committed rows stand in for provider effects; no HTTP provider exists in this
fixture.

## Passing scenarios

1. Kill a worker with an uncommitted prepared intent. Its transaction rolls back;
   a new process sees no orphan and can prepare/approve normally.
2. Concurrent processes replay the same preparation and produce one intent.
   Competing processes acquire only one committed submission claim.
3. Concurrent submission requests produce exactly one simulated provider effect.
   A later replay returns the stored result without another submission.
4. Kill after committing the claim, before contacting the simulated provider.
   A new process retains uncertainty; observation cannot authorize a resend.
5. Kill after committing the simulated provider effect, before recording its
   receipt. A new process observes matching terms without attributing that
   observation as a verified submission or repeating the effect.
6. Kill after committing provider acceptance. A new process preserves that
   attempt and recovers by reading, never by resubmitting.
7. Stop the private PostgreSQL server in immediate mode and restart it, forcing
   crash/WAL recovery. Both a verified receipt and an uncertain post-effect claim
   survive. Neither is resubmitted.

Inspection also checks that the real journal excludes raw financial fields,
amounts and candidate/application identities. Normal cleanup kills only this
invocation's workers, stops only its cluster and removes its temporary directory.
If shutdown fails, the directory is retained rather than deleted beneath a
running server. Do not use a namespace-wide cleanup sweep after interruption.

## What this does not prove

- Live Greenhouse acceptance, real permission/field/approval configuration,
  actual provider side effects or candidate delivery.
- Actual HTTP replica routing, deployed PostgreSQL storage behavior, infrastructure
  failover or production capacity.
- Real staff/HR/erasure authority fencing: the source is expressly synthetic.
  The separate workspace HTTP regression exercises local authority paths.
- Atomicity of a future provider/custody adapter or its integration with the
  financial workflow. The fake effect table shares the disposable database;
  the kill-after-effect case models an uncertain external acceptance boundary,
  not a separate provider outage or distributed transaction.

BUILD-02 remains Blocked for verified employer adapters/transport and authorized
acceptance. The missing local committed-ledger durability check is now covered;
it is not a reason to enable live submission.

## Files

- Runner: `artifacts/api-server/scripts/greenhouse-offer-durability.test.mjs`
- IPC worker:
  `artifacts/api-server/src/lib/ats-connectors/fixtures/greenhouse-offer-durability.worker.ts`
