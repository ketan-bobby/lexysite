# Controlled sourcing execution worker

## Scope

This is the execution/recovery layer for a bounded sequence of sourcing
operations. It is tested with controlled provider ports against the existing
development lease, approval and ledger tables. It is **not** a live provider
adapter, a customer-facing start button or an end-to-end autonomous hiring run.

Cost calibration is deferred at the product owner's request. Missing billing
statements do not block engineering/testing the automation. Synthetic test
bounds and receipts are clearly labelled as fixtures and are never account
pricing or invoices. No public rate grants execution authority.

## Implemented behavior

- Snapshot the supplied operation sequence before asynchronous work begins.
  Duplicate keys and empty/unbounded plans fail before lease acquisition.
- Bind the plan digest to durable lease ownership, with a fresh process identity
  for each generation. Recoveries cannot change order, requests or keys, or
  remove the binding by using an unbound worker. No request content is stored
  in the worker identity.
- Prepare all operations before the first external side effect. Partial
  preparation recovers with the original IDs, attempt tokens and bounds.
- Execute sequentially. Already-settled operations are replayed without calling
  the provider again.
- Heartbeat the lease and re-check current human authority, approved snapshot,
  requisition status, hold state and original deadline. Final success is checked
  again; it is an operation-batch result, not a candidate hiring outcome.
- Abort in-flight work on revocation, pause/cancel or worker stop. Stop dequeuing
  subsequent operations. A synchronously aborted, never-returning adapter cannot
  cause a missed-abort hang.
- Mark interrupted/dispatched attempts uncertain and refuse to resend them after
  recovery. Late receipts can settle only their original attempt.
- Release only the matching owner/generation/actor. A late predecessor cannot
  release its replacement's lease. Pause/resume never resets runtime.

The existing USD-cap and candidate-limit checks remain intact. Abort is not a
vendor recall/refund guarantee. Best-effort usage telemetry remains separate
from these durable control records.

## Safety boundary and remaining integration

The paid-operation worker accepts test ports only, and only under `NODE_ENV=test`.
Its shared lease lifecycle is now also used by the production-safe local-only
internal discovery action described in [internal discovery](sourcing-internal-discovery.md).
That action saves a tenant-owned shortlist without provider/model calls, outreach
or candidate stage changes. The paid sourcing dispatch lock stays in place;
there is still no live adapter registry or automatic sourcing scheduler.

Local internal Start/Resume controls are connected. Subsequent work must connect
separate live external activation, audited per-request provider ports, durable
provider/result checkpoints and dynamic stage planning. Engage/interview
orchestration and final human hiring checkpoints are separate phases. This
controlled batch worker does not claim acceptance of those phases.

No schema change or migration is needed: the plan digest is carried in the
existing bounded lease-owner field. Its reserved `sourcing-plan:` namespace must
not be stripped or replaced during takeover.

## Verification

The guarded sourcing-controls suite passed **38 tests**, including nine worker
integration cases. It exercises the actual approval/lease/ledger database paths
with isolated fixture requisitions and controlled adapters. Fixture records are
removed by the suite's existing cleanup. No paid provider calls are required.

Existing cases also cover USD exposure, deadline and candidate limits, foreign
tenant denial, paused/resumed holds, abnormal receipts and metering-table RLS.

The final assisted gate passed **312 API tests**, **34 frontend logic tests** and
**five outbound-guard tests**, plus frontend typecheck, API build/structural
checks and no-new-debt lint/format checks. Strict targeted typechecking of the
worker and its plan helper passed. Full logs are at
`/tmp/lexy-assisted-baseline-5YfFFP`.

One managed API restart completed recovery before listening; health returned
`ok` and the unchanged sign-in screen rendered. The existing dormant-Stripe
sentinel warning and operational SES notifications remained; no billing
configuration was changed. No live autonomous run, migration or production
publish occurred.
