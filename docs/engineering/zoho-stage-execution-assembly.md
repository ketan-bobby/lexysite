# Zoho stage execution — internal assembly

**Current integration:** the [controlled stage-execution workflow](zoho-controlled-stage-execution.md)
now supplies the concrete connected source, separate-purpose ledger requests,
explicit public routes and staff controls. Runtime execution defaults off.
Real employer evidence and authorized live dummy acceptance remain outstanding.
The sections below describe the earlier internal increments.

**Current restart coverage:** the
[connected-assembly restart regression](zoho-stage-restart-testing.md)
now passes 17/17 test results, including nine new isolated HTTP/rule/OAuth
assembly scenarios. The historical eight-check ledger result below is retained
as earlier evidence, not the current coverage total. Provider and login identity
remain simulated; real employer acceptance and human uncertainty resolution
are separate.

**Subsequent evidence increment:** the
[employer transition evidence workflow](zoho-employer-transition-evidence.md)
now supplies authenticated intake, separate employer review, immutable history
and a same-transaction proof loader. This is employer-human evidence verification,
not provider-discovered eligibility. Real employer evidence and authorized
dummy acceptance remain open; live dispatch has not been activated.

**Cross-staff identity increment:** the internal execution protocol now allows a
freshly authorized staff member to approve or execute a request prepared by
another staff member. The request revision binds transition content, tenant,
scope, source, connection and proof, while fresh source snapshots and locked
snapshots must still identify the actual caller. The frozen preparer is never
rewritten; approval and claim/receipt audit events retain their real authors.
Cross-staff SQL claims require an explicitly bound receipt actor.

The content-revision protocol is deliberately versioned. Earlier actor-bound
approvals are retained, not silently upgraded into executable approvals. A fresh
preparation and approval are required for a new executable revision. Any older
uncertain claim remains held across that protocol change: it can be observed
read-only, but a new revision cannot bypass the unresolved-attempt hold.

These checks are exercised with injected staff authority and provider responses
against private SQL fixtures, not real employer accounts. Connected execution
source/route/UI assembly is now provided by the current integration linked above.

Verification on 2026-11-15: **114 focused checks passed** without failures or skips,
including eight new cross-staff/content-revision regressions. The separate
durability run passed **eight checks**, including killed workers, competing
processes and PostgreSQL immediate-stop recovery in its own disposable cluster.
That run did not use the application database or contact Zoho. These results
do not establish production capacity or real employer acceptance.

## Implemented locally

`zoho-stage-execution.ts` joins the existing stage writer, SQL request ledger and
injected authority/provider contracts into one internal workflow:

1. Prepare a frozen, application-bound snapshot with verified transition evidence.
2. Explicitly approve that exact request under the supplied authority transaction.
3. Separately execute the exact approved request. Persist the attempt claim before
   calling the injected transport, then require matching read-back for verification.
4. Recover an uncertain attempt by reading only. A matching remote status is an
   observation, not proof that Lexy caused it and never permission to resend.

Preparation and approval cannot call the write transport. This earlier internal
increment added no route, scheduler, OAuth scope, default provider, token source or automatic dispatch.
The original stage-request controls remain local/simulation-only and report their
dispatch as unavailable. Separate controlled execution is linked above.

The source must be server-owned and supply both the validated snapshot and its
authority transaction. Transition proof cannot come from a client request,
default stage catalogue or transition history. The executor checks exact actor,
tenant, campaign, recipient, snapshot revision, request ID, approval, account,
application binding, consent and proof lifetime. Existing writer checks revalidate
inside the authority fence and after the preflight provider read.

## Local evidence

On November 14, 2026, **80 focused tests passed**, with no failures or skips,
including eight new assembled-workflow scenarios. API typecheck passed.
The added SQL fixture uses a private temporary audit table on verified local
development PostgreSQL and rolls back. HTTP is injected and external egress is
guarded; no Zoho request or candidate contact occurs.

The new scenarios cover:

- no provider reads/writes from preparation or approval and no execution before
  approval;
- successful exact-request execution and reconstructed replay without another
  write;
- missing proof, permission or human decision;
- caller-supplied proof, false confirmation, wrong request and foreign tenant;
- changed source revision, expired proof and changes observed under the lock;
- proof expiration while waiting for preflight read;
- response loss, non-attributable read-only recovery and replacement connections;
- failed receipt persistence retaining a claim; withdrawn approval and offer
  targets cannot execute.

The private transaction demonstrates SQL integration, not independent commit or
crash durability. Separate existing durability/authority tests retain their
original evidence boundaries. This increment did not rerun the full baseline,
restart an application server or prove a real employer's permissions.

Repeat the focused group with:

```sh
pnpm --filter @workspace/api-server run test:zoho-stage-write
```

The new test is also included in the assisted-baseline manifest.

## Still required before live execution

This is **not a completed live Zoho stage integration**. The public local requests
currently store no verified transition proof and cannot simply be promoted into
executable requests. A proof or source change requires a new frozen snapshot and
explicit approval of its new revision.

Live integration still requires a supported employer/application-specific
transition contract, reviewed Blueprint/mandatory-field/notification effects,
a concrete server-owned proof/source adapter using the existing stage authority
and custody locks, binding the connected provider described below and explicit
route/UI integration. Only then can an authorized dummy write/read-back establish
employer acceptance. A future route must reject forged authority and preserve
separate approval and deliberate execution.

No offer issuing, employment transition or automatic retry is enabled by this
assembly. Greenhouse financial offer integration is a separate open item.

## Connected OAuth transport

`zoho-stage-connection.ts` implements the concrete employer credential and
provider boundary. Its **read-only mode** is bound to the existing public request
recovery action. Its write mode is not mounted in the public request routes.

- It resolves the current employer-approved sealed credential through the
  existing OAuth store. Current requester and credential owner must both pass
  the existing employer-admin gate.
- Exact account, connection, configuration and ciphertext custody hashes must
  match the server's stage authority context. Explicit saved stage-write consent
  is required for write mode; note or read-only consent is insufficient. Recovery
  mode requires current approved read custody and cannot perform writes even when
  the credential also carries write consent or a caller supplies a transition proof.
- Token refresh and organization confirmation use the existing regional OAuth
  provider. Credential replacement during those reads invalidates connection
  creation. Neither token is returned to the caller.
- The returned `fence(work)` rechecks custody before acquiring the existing SQL
  stage authority fence. Application reads and writes require that connection's
  active asynchronous fence context. Another connection cannot borrow the fence;
  retained provider methods are unusable after it closes. Nested acquisition is
  rejected.
- Application reads use the exact Applications endpoint and validate all three
  external IDs. Writes use the existing bounded, fixed-origin, single-candidate,
  single-job transport and its proof/permission/forbidden-outcome guards. Each
  fence permits at most one write invocation, including uncertain responses.
- Once the SQL fence is held, provider methods do not acquire additional pool
  connections. The existing locks and source recheck retain authority through
  I/O. Callers must await all provider work inside the fence.

The future concrete execution source must implement its `fence` by calling this
connection's `fence` and pass that transaction to the locked snapshot reader and
ledger. Pass the same connection's `provider` to `zohoStageExecution`. Retain the
ledger's durable claim and separate prepare, approve and execute actions; the
connection is not a substitute for them.

The connected adapter tests use synthetic credentials and an injected HTTP
transport only. They cover US/India origin pinning, rotation, revocation,
foreign identity, absent/expired proof, restricted outcomes, fence lifetime,
single invocation, and composition with the real rollback-only SQL ledger.
The composed test checks approval, claim-before-HTTP, replay through a reconstructed
executor, and read-only recovery after a simulated accepted-but-lost response.
SQL authority locking itself remains covered by the separate existing authority
tests; the composition fixture does not claim employer acceptance or crash
durability.

### Public read-only recovery binding

The existing `zohoStageRequests.act(..., action: "recover")` now resolves a
read-only connection only after checking the exact saved request, binding,
connection and durable execution claim. OAuth/custody checks precede the SQL fence.
Inside it, the service reads the exact application once, independently checks all
three external IDs, rechecks source evidence using that same transaction, and
appends only `observed_target` or `observed_other`.
It no longer re-enters the general stage-catalogue validation and source/context
readers while holding the recovery fence. Existing independent journal commits
retain their prior durability behavior.

This action requires no new write consent, never sends a stage update, and never
turns observation into delivery attribution or permission to retry. The existing
route and UI contract are unchanged. Preparation and local approval remain local;
the original local-only route still rejects execute/send/retry actions.

The subsequent evidence and controlled-execution increments supply the proof
workflow and write route/UI wiring. They do not supply real employer evidence,
live activation/acceptance, production mutation or Greenhouse account verification.
