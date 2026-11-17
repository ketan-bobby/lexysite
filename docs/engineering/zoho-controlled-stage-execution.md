# Controlled Zoho application-stage execution

## Development implementation

Lexy now connects the employer evidence workflow, current source authority,
employer-bound OAuth transport and durable request ledger to explicit staff
controls. This is **not live employer acceptance or a production rollout**.
All implementation checks use isolated fixtures and simulated Zoho responses.

The normal API router registers:

- `GET /api/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-execution`
- `POST /api/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-execution`
- `POST /api/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-execution/:requestId/actions`

The existing tenant-admin, exact campaign/recipient and candidate-privacy gates
apply. Read responses use `Cache-Control: no-store`. GET only reads local
authority/history; it never refreshes OAuth or calls Zoho.

The controls appear after the employer evidence review within the existing
campaign recipient's stage-handoff workflow. They are distinct from the earlier
local-only simulation controls and history.

## Activation

`ZOHO_STAGE_EXECUTION_ENABLED` must equal the literal string `true` before an
execute action can invoke the write transport. Missing, false or other values
leave execution disabled. **It was not enabled for this implementation.**
The flag is checked again immediately before the provider write.

Preparation, separate approval, withdrawal and eligible read-only recovery do
not require activation. Preparation/approval perform explicit bounded provider
reads, but never issue the status-changing request. Activation is not billing,
not proof of a supported transition, and not permission to bypass the remaining
human, scope, custody or provider checks.

Only an authorized employer should enable a separately approved, isolated
dummy acceptance test after reviewing actual application-specific contract,
isolation, mandatory-field/Blueprint and side-effect evidence. Never set the
flag merely to make a disabled button active.

## Separate commands and request purposes

1. **Prepare:** require the handoff revision, exact verified rule revision,
   UUID command identity and literal `confirm: true`. Derive all provider
   identities, status values, current decision and proof on the server.
2. **Approve:** approve the exact execution-purpose request revision. Save the
   approval only; no provider write occurs.
3. **Execute:** require another deliberate action and acknowledgement, the exact
   approved revision and rule, a UUID execution command and current activation.
   Persist the execution claim before the provider side effect.
4. **Withdraw:** a local action for eligible unexecuted requests. Does not need
   renewed evidence or provider access.
5. **Recover:** use the existing read-only employer-bound recovery path. It needs
   current staff, source, privacy, account and connection authority, but not
   renewed evidence, new write consent or activation.

The audit envelope now records `purpose: local | execution`. Earlier envelopes
without that field are read as `local`; no database migration or data rewrite
is required. Purpose is immutable across a request's journal history.
Local-only approvals cannot approve or claim an execution-purpose request.
Matching content cannot carry over an earlier local approval.
An existing non-withdrawn execution request for the same evidence also prevents
another preparation being described as new. Exact preparation-command replay
returns saved history without provider reads; a finished request requires a new
evidence review before preparing another attempt.

Both purposes use the same per-application durable claim/hold boundary.
An older local-purpose unresolved claim still blocks new execution.
`claimed`, `provider_accepted`, `review_required`, `observed_target` and
`observed_other` remain held unless a separate current administrator independently
approves an explicit human closure after read-only recovery. See
[uncertainty resolution](zoho-stage-uncertainty-resolution.md). This never changes
the observation into a delivery receipt or retries it. After closure, older
prepared requests and transition evidence cannot authorize another write.

## One source-authority transaction

The connection's injected authority fence delegates to the verified-rule loader
instead of nesting two independent pooled transactions. The loader rechecks the
exact source, mapping, custody, account, candidate privacy, current actor and
independent evidence reviewers. The connection context must exactly match that
locked context.

An async-local lease binds the derived snapshot and transaction to the guarded
provider operation. Context/metadata/custody reads happen before the SQL fence;
no general pooled source reads are introduced while those locks are held.
The transport additionally checks its own lease, exact binding, actor, region,
connection and one-invocation limit.

The rule's full revision is included in the proof reference. Preparation,
approval and execution revalidate it. Expiry, changed proof or source,
revocation, unsupported outcomes and mismatched remote identity fail closed.
Offer, hire and onboarding outcomes remain outside this stage executor.
Offers continue through the separately human-controlled employer handoff.

## Ambiguity and client behavior

- Exact execution-command replay returns saved local history without contacting
  Zoho again. A different command cannot reuse an already claimed request.
- The UI retains command identities after failed requests, including 4xx
  responses: a response failure can follow a committed effect.
- Mutation failures reconcile local history without automatically resending.
- Candidate/staff scope changes, failed authority reads and changed row
  capabilities clear acknowledgements; cached private data is hidden on errors.
- Provider acceptance requires exact read-back before `verified`.
- A recovery observation is never relabelled as delivery proof or retry consent.
- A conservative post-claim rejection, including activation being withdrawn
  during preflight, may remain held for review even if no provider write occurred.

## Verification and handover boundaries

On 2026-11-15, **126 focused Zoho checks**, **eight isolated ledger durability
checks**, and **40 fixture-browser scenarios** passed. The browser run included
12 new execution-control cases and desktop/mobile checks; it used Puppeteer with
all API traffic intercepted, not an employer's signed-in Zoho account.
API/web typechecks, build guards, targeted lint and root formatting were checked.
The broader assisted baseline initially found missing browser-fixture mocks for
the two new GET routes and a formatting failure in the updated browser script.
The fixture routes were added, the dedicated 40-scenario browser run passed, and
root formatting passed after formatting the script. The entire broad baseline
was not rerun merely to repeat its other passed steps. A separate earlier
`offer-browser` run stopped at fixture navigation timeout (0/36 completed).
That fixture startup issue has now been addressed with Vite module warmup and
a bounded 30-second navigation timeout while preserving 10-second interaction
timeouts. The dedicated controlled-offer browser suite subsequently passed
**36/36** scenarios; this is not a claim that the entire broad baseline was rerun.

The focused Zoho suite includes private SQL composition checks that exercise the
real rule loader, journal, connection, executor and HTTP router with synthetic
provider responses. Only the outer source-row fixture and upstream service are
simulated; source/custody SQL barriers also have their existing separate tests.
The UI browser fixture intercepts API requests and does not establish live
employer acceptance.

The disposable-PostgreSQL durability suite now also reconstructs the connected
HTTP/rule/OAuth/dispatch assembly in fresh workers. Nine additional scenarios
cover process interruption before/after claim, effect and saved acceptance,
database crash recovery, local-only approval separation, disabled execution,
expired evidence, revoked reviewer authority and changed source evidence.
It uses the real stage SQL barrier with minimal source rows, synthetic login
identity, a fixture canonical note-source fence and simulated upstream Zoho.
See [the restart regression guide](zoho-stage-restart-testing.md) for the exact
coverage and isolation limits. This is not a deployed server-bootstrap or
production-capacity test.

The complete expanded durability run passed **18/18 test results**: 17 scenarios
plus their parent, with no failures, skips or cancellations.
The added closure scenario exercises competing reviewers, a PostgreSQL restart,
and a local-only replay after closure. The campaign browser fixtures passed
**62/62** cases, including 22 closure cases across desktop and 390px viewports.

Still required externally: genuine employer evidence and independent review,
authorized isolated dummy write/read-back, deployment configuration/migration
checks on the employer's own hosting, and team acceptance. No production
settings, live Zoho records, candidate invitations or LLM configuration were
changed by these implementation checks.
