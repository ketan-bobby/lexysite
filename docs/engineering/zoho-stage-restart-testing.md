# Controlled Zoho execution: isolated restart regression

## Purpose and safety boundary

The restart suite reconstructs the connected stage-execution assembly in fresh
worker processes. It uses a newly initialized PostgreSQL cluster with a private
Unix socket, no TCP listener, and default durable writes enabled. Before importing
the assembly, each worker verifies the exact database directory, PostgreSQL system
identifier, and a random ownership marker.

The application database, production servers and real Zoho accounts are not used.
Workers receive an allowlisted environment with synthetic SDK initialization
values, never inherited provider credentials. The HTTP egress guard permits only
servers owned by the test process. No candidates are contacted.

## What is real and what is simulated

Real application modules:

- Staff-facing stage-execution HTTP router, strict command validation, generated
  response validation and `no-store` responses.
- Dispatch service and the prepare → approve → execute separation.
- Employer rule journal and independent-review checks.
- Execution journal, immutable local/execution purpose and committed claim.
- SQL stage-authority barrier, including current staff, connection custody,
  candidate privacy, exact application binding, mapping and source rows.
- OAuth connection adapter, application-response parsing, stage HTTP payload
  adapter, provider acceptance/read-back and read-only recovery.

Simulated boundaries:

- Login identity is supplied by a fixture; this is not a session-authentication
  regression or a test of deployed server bootstrap.
- Canonical interview/note source assembly is replaced by a persisted fixture
  source and transaction fence. Separate source-race tests retain coverage of
  the real canonical note-source checker.
- OAuth refresh/organization responses and upstream application responses are
  synthetic. The independent provider-effect row represents a committed external
  side effect, not a Zoho transaction or a real remote stage change.
- Source tables have the minimal shape needed by the actual SQL stage barrier.
  This does not validate the production migration set, request-role RLS or
  production load capacity.

## New scenarios

Every command below runs in a new worker with a new service graph and ephemeral
HTTP listener. Only committed database state survives:

1. Kill before claim: the approval remains; a deliberate execution with the same
   command can complete one simulated effect.
2. Kill after committed claim but before provider invocation: restart/replay
   never sends; recovery observes the original status and retains the hold.
3. Kill after the simulated provider effect but before acknowledgement:
   restart/replay never sends; read-only recovery observes the target without
   claiming attributable delivery or releasing the hold.
4. Kill after saved provider acceptance: restart/replay remains local and
   read-only recovery retains the hold.
5. Immediately stop/restart PostgreSQL after a killed worker's provider effect:
   the claim, duplicate protection and immutable local-only approval boundary
   survive database crash recovery.
6. Disabled execution in a fresh assembly rejects before OAuth/provider access.
7. Expired evidence in a fresh assembly rejects before OAuth/provider access.
8. Revoking the independent reviewer's staff authority persists across workers
   and blocks execution.
9. Changing the persisted source revision blocks execution by a fresh worker.

The existing seven ledger/source-race scenarios remain in the same suite.

## Running the suite

The complete expanded run passed **18/18 test results** (17 scenarios and their
parent), with zero failures, skips or cancellations. API type checking, targeted
fixture lint and whitespace checks also passed.

The added uncertainty-closure scenario kills an execution worker after its
simulated provider effect, recovers read-only, saves a closure proposal and races
two independent reviewer processes. Exactly one review commits. After an
immediate PostgreSQL stop/restart, the approved closure and original observation
remain; exact execution replay performs no provider requests and the simulated
effect count stays one.

```sh
pnpm --filter @workspace/api-server run test:zoho-stage-durability
```

For focused investigation only:

```sh
ZOHO_DURABILITY_CASE_FILTER=before_claim \
  pnpm --filter @workspace/api-server run test:zoho-stage-durability
```

A filtered run explicitly reports skipped scenarios and is not a full pass.
The parent always shuts down only its own PostgreSQL cluster and cleans its
temporary files. A failed shutdown preserves the cluster for investigation
rather than deleting files from a running database.

## Still separate

Live execution stays disabled by default. These tests do not authorize enabling
it. Genuine employer evidence, independent review and an authorized isolated
dummy write/read-back remain connected-acceptance work. Staff resolution of
uncertain attempts uses the [separate independent-review control](zoho-stage-uncertainty-resolution.md):
read-only recovery itself never releases a hold,
automatically retries, or changes an observation into a delivery receipt.
