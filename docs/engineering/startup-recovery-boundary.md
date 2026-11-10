# Startup recovery boundary

## Behavior

The scheduler-leader API awaits agent-run and pipeline-run status recovery before
opening its HTTP socket. Schedulers and the inline AI worker still start on the
first listening event, so they cannot start new work before this boundary.
Readiness cannot report success while the HTTP socket is unopened.

Recovery errors or a 20-second deadline prevent listening and terminate startup
with a nonzero exit. A late completion after timeout does not open the socket.
The deadline bounds startup waiting; it is not a durable worker cancellation or
distributed lease. Port-in-use retries do not repeat recovery.

Agent recovery updates only queued/running rows created strictly before Node's
process-start timestamp. Rows at/after that cutoff, and completed, failed or
cancelled rows, are excluded. Interrupted old rows retain the existing failed
status and restart explanation. The existing event writer remains best-effort.

Pipeline recovery preserves its existing 15-minute staleness threshold and
interrupted status. Startup requests strict error propagation; other callers
retain the existing best-effort behavior.

## Boundaries

- This relies on the existing one-configured-scheduler-leader contract. Followers
  do not recover rows. It does not establish distributed ownership/fencing or
  prove safety with multiple misconfigured leaders.
- Shared-database tests must still run after application startup is settled.
  A fixture created before a new process starts is not distinguishable from a
  real prior orphan. No fixture-looking IDs are exempted from production recovery.
- No paid calls, provider adapters, pricing, credits, schema or billing authority
  are changed. Autonomous dispatch remains disabled.
- Normal API restart still runs existing operational security notifications.
  Tests of the new boundary use fake recovery and an isolated HTTP server, not
  the real application entrypoint or email-enabled startup.

## Verification

New guarded tests exercise delayed HTTP startup, rejected/synchronous recovery,
timeout plus late completion, invalid deadlines, entrypoint wiring, compiled SQL
cutoff/status predicates, unchanged terminal/fresh rows, tenant-labelled events,
idempotence and strict database failure propagation.

Recovery predicate tests use the actual Drizzle WHERE compiler but in-memory
rows and mocked writes; they do not run an unrestricted recovery UPDATE against
the shared database. Existing pipeline recovery coverage uses its own fixtures.

This fixes the observed HTTP/startup race, not autonomous paid restart recovery
or every possible shared-database test collision.

### Results — 2026-10-06

- Full assisted gate: **295/295 API tests**, **34/34 frontend logic tests**,
  **5/5 outbound-guard tests**; frontend typecheck and API build/structural guards
  passed. Existing lint/format debt was unchanged.
- The earlier focused pass also covered the existing pipeline fixture recovery
  test. New predicate tests subsequently tightened mock error checking so
  swallowed event-writer errors cannot hide a bad recovery fixture.
- One managed API restart verified the recovery-complete log precedes listening,
  schedulers and the inline worker. `/api/healthz` returned HTTP success with
  database health `ok`; the public sign-in page rendered.
- No real provider calls were used by the regression harness. The normal restart
  did send existing operational security emails and logged the pre-existing
  dormant-Stripe warning. No billing settings, paid-dispatch authority, production
  migration or publish was changed; globally clean logs/zero outbound activity
  are not claimed.
- Full test logs: `/tmp/lexy-assisted-baseline-memsFJ`.
