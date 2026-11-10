# Controlled Zoho stage requests and execution boundary

## Status

The execution protocol, bounded HTTP adapter, PostgreSQL-backed request ledger,
authenticated local approval API and staff request/history controls are implemented.
**Live stage dispatch remains unavailable:** an employer-specific application
transition contract and safe live acceptance have not been established.
The older handoff simulation remains separate from real saved local requests.

Tenant admins can prepare a request after an explicit read-only Zoho metadata
check, approve it locally, withdraw it, and inspect its history across reloads.
Approval never dispatches, schedules an eventual send, or contacts the candidate.
Uncertain executable attempts have a read-only observation path; matching the
target is not attributable delivery and cannot enable a resend.

An optional, default-off OAuth checkbox requests the documented candidate-update
scope separately from notes and read-only metadata. The UI discloses that this is
broader provider permission than a single stage field. Browser-bound encrypted
custody and current employer/owner authority are checked locally. No existing
connection is upgraded or reconnected automatically.

The existing append-only audit table stores the ledger, scoped by tenant,
campaign and recipient. Advisory-locked transactions serialize preparation,
approval and execution claims. Raw external candidate/application/job IDs are
not copied into audit metadata: binding hashes are compared before reconstructing
an attempt from the authorized current recipient. Canonical source/privacy,
account and mapping fences protect preparation and approval.

The stage-specific transaction barrier now also locks and rechecks the current
tenant-pool/contact/erasure state, acting admin and connection owner, campaign,
mapping, job and frozen plan. It compares a non-reversible digest of the saved
encrypted OAuth custody and its configuration fingerprint under the account lock,
so replacing a grant without changing its connection revision cannot pass an
in-flight check. No credential or digest is added to browser responses.

Read-only stage recovery now acquires that barrier before contacting the provider
and holds it through the observation receipt. Canonical evidence/review is checked
again on the same transaction after acquiring the additional locks. This barrier
is wired into current stage operations; a future live executor must explicitly
reuse it. Adding the barrier does not enable dispatch or supply transition proof.

No production access, remote candidate edit, stage change, Zoho stage-triggered
notification, OAuth scope change or connection replacement was made for this implementation.
No new database schema or migration was introduced.

## Implemented independently of team availability

- Explicit confirmation bound to exact actor, tenant, campaign, recipient,
  application, candidate, job, employer account and connection.
- Approval fingerprints include current human-decision/source revision, mapped
  target, transition evidence and permission state.
- Fail-closed checks for missing permission, stale decisions, wrong bindings,
  offers/employment targets, future/expired transition proofs and proofs with a
  validity window longer than 15 minutes.
- A required durable-store interface: committed atomic claim before external
  mutation, request/revision deduplication, unresolved-attempt blocking and
  append/CAS receipt recording. No in-memory store is used by the application.
- A required authority-fence interface that must hold current staff, candidate
  privacy/erasure, source evidence and employer-account authority during I/O.
- Exact application/job/candidate and expected current-status read immediately
  before mutation. Proof expiry is checked again after this read.
- One external invocation only; no transport retries, redirect following,
  global-candidate fallback, generic record-update fallback or Blueprint revoke.
- Verification requires both an exact accepted provider response and matching
  application read-back. A matching status before execution is only a no-op.
- Timeouts, malformed/batched responses, mismatched identifiers and uncertain
  outcomes remain held. Provider/transport error text is not returned.
- Read-only recovery distinguishes `observed_target` from attributable
  `verified` delivery. Observing the target after a lost response never proves
  Lexy caused it and never authorizes an automatic resend.
- Bounded 128,000-byte response reader, fixed US/India Recruit origins and
  20-second request timeout.

## What the HTTP adapter proves — and does not prove

The adapter encodes Sample Input #2 of Zoho Recruit's official
[Change Status API](https://www.zoho.com/recruit/developer-guide/apiv2/change-status.html),
reviewed on 2026-11-06:

```text
PUT /recruit/v2/Candidates/status
data: [{ ids: [one candidate ID], jobids: [one job ID],
         Candidate_Status: exact approved status, comments: fixed handoff text }]
```

Its nested single-result success parser requires the expected candidate ID.
An unexpected response shape remains uncertain; it is not coerced into success.

That published example does **not** independently establish the employer's
Applications-enabled or Blueprint behavior. The current implementation does not
invent an `Applications/status` contract, reinterpret transition history as
allowed next actions, or mistake the default catalogue for eligibility.

Transition proof must come from a subsequently verified provider contract and
employer authority. It is internal evidence, **not a browser-submitted checkbox
or a caller-supplied `verified: true` value**. No such proof is currently
generated by the production application.

Zoho documents that application status changes can trigger email/SMS/webhooks
and that some employment actions affect other applications. Those effects must
be reviewed before a live dummy transition:
[Applications documentation](https://help.zoho.com/portal/en/kb/recruit/talent-management/applications/articles/applications-in-zoho-recruit).

## Remaining implementation — not merely a live-test checklist

Before exposing a live-write action, implement and verify all of:

1. Finish execution-side source/provider wiring after verified transition evidence
   has a trustworthy origin. Current local requests deliberately carry no such proof.
2. Verify the deployed execution path and actual request-role boundary under
   concurrent authority/erasure changes. The isolated multi-session check now
   exercises the real combined note/source/stage fence, but not deployed HTTP
   authorization, request-role RLS or the real erasure service.
3. Validate the explicitly requested update scope against the employer's actual
   Recruit account; local opt-in is not proof that a transition is permitted.
4. Provider-contract evidence for one exact application transition, including
   Blueprint/required-field behavior and reviewed notification side effects.
5. A live execution action bound to verified transition evidence and current
   authority. Existing request APIs/UI cover local preparation, approval,
   withdrawal, history and read-only recovery, not live dispatch.
6. One authorized safe dummy live transition, read-back and other-application
   isolation check; no real applicants and no unapproved notifications.

An existing dummy record alone is not consent to contact its saved recipient.
Team unavailability does not block synthetic development, but it does not make
unverified live side effects safe.

## Validation

```sh
pnpm --filter @workspace/api-server run test:zoho-stage-write
```

The test is also registered in the assisted-baseline API manifest. It includes
synthetic execution/service/route tests and a real PostgreSQL ledger check in a
private, rollback-only temporary table on verified local development PostgreSQL.
The rollback-only SQL check proves storage/reconstruction, tenant scoping,
deduplication and monotonic updates. Provider acceptance and live deployment
readiness are not established by these tests.

On 2026-11-06, 18 focused stage authority/request checks passed, including an
installed development-schema compatibility check with nonexistent synthetic
scope, a rollback-only SQL fixture with 22 changed-authority/privacy/binding
counterexamples, and recovery read/receipt ordering tests. The fixture checks
use an administrative development handle, not an actual authenticated request
role or live provider. The development API rebuilt with TypeScript/security
guards passing and health returned 200 after restart.

An automatic combined baseline overlapped these edits and recorded four
stage-request failures against an older fixture lacking the new custody fields.
Those changed flows passed the subsequent focused run. This does not turn the
overlapping baseline into a passing release gate; run the full gate after source
changes settle. The earlier unrelated browser/format failures also remain open.

### Separate committed crash-recovery check

```sh
pnpm --filter @workspace/api-server run test:zoho-stage-durability
```

This opt-in check requires `initdb` and `pg_ctl` on PATH and creates its own
temporary PostgreSQL cluster, with a private Unix socket and no network listener.
It never connects to the application database or inherits integration credentials
into its workers. It does not run migrations or alter the shared database.
An exact data-directory, server identity and per-run ownership token are checked
before worker operations. Normal completion stops and removes only that cluster;
failed shutdown preserves its directory rather than deleting an active server.
Do not clean up another run by scanning/deleting a directory prefix.

On 2026-11-06, all six scenarios passed (seven Node test entries including the
parent):

- Killing an uncommitted preparation rolls back its ledger row.
- Killing after the committed claim prevents another execution.
- Killing after a simulated external effect, before recording acceptance, holds
  the attempt; recovery observes the target without claiming delivery or resending.
- Killing after committed provider acceptance preserves that state and remains
  observation-only during recovery.
- Competing processes acquire exactly one committed execution claim.
- Verified receipts and uncertain claims survive PostgreSQL immediate shutdown
  and WAL recovery, with `fsync`, `full_page_writes` and synchronous commits on.

The check also runs 22 concurrent-ordering checks across 11 authority/privacy
changes using three real PostgreSQL sessions and the actual stage SQL barrier:
acting-admin and connection-owner suspension, DNC, pool changes, canonical erasure,
ATS-alias erasure, grant replacement at unchanged revision, employer approval
revocation, mapping/campaign replacement, and plan reassignment. It observes
`pg_blocking_pids` rather than inferring blocking from a timed sleep.

For every case, a revocation that obtains its lock first commits before the
waiting authority check and prevents protected work. Conversely, a revocation
cannot finish while the authority barrier owns its locks; after the operation
releases them and the revocation commits, the next check rejects.

The alias-erasure case reproduced a READ COMMITTED snapshot race: inserting a
tombstone while holding the candidate lock does not necessarily change the
candidate tuple. A statement started before that insertion can miss the tombstone
even after waiting for the lock. The barrier now re-evaluates its full predicate
in a second statement, after acquiring the locks. The current run passed all
eight Node test entries, including these 22 ordering checks and the six original
durability scenarios. The focused stage suite also passed all 66 checks.

The expanded check additionally runs the actual ORM transaction from the note
store, the stage SQL barrier and the canonical interview-evidence/latest-review
checker together. It uses an unchanged-data positive control plus 18 ordering
checks across nine changes: saved answer, assessment narrative, plan questions,
job context, latest human review, acting-admin suspension, DNC, unchanged-revision
grant replacement and ATS-alias erasure. Changed source or authority committed
before lock acquisition prevents the protected callback; writers waiting behind
the active callback cannot complete until its transaction releases the locks.
The next operation rejects the newly changed state.

The question/job edits specifically verify that the final source check runs
after the additional stage locks, rather than relying only on the note fence's
earlier source read. All 40 ordering checks, the unchanged-data control and six
durability scenarios passed in the same isolated-cluster run (eight Node test
entries including its parent). A separate regression run passed 86 stage,
campaign-review and note-publication checks.

The check uses the actual SQL ledger and internal execution protocol with
synthetic authority/transition proofs and a database-backed simulated provider.
It does not establish real Zoho behavior, filesystem/power-loss guarantees,
deployed infrastructure durability, RLS, authenticated HTTP authorization or the
real erasure service. The concurrency tests use an administrative role in the
disposable cluster; their alias-erasure writer explicitly follows the
candidate-lock protocol. They do not prove safety for a tombstone writer that
bypasses that protocol. It is separate from the automatic assisted baseline and
must not be counted as live acceptance.

On 2026-11-06, 83 focused protocol, ledger, service, route, OAuth and metadata
tests passed. TypeScript, targeted lint/formatting and the development API's full
build/security guards passed. API health returned 200 after restart.

The isolated browser journey passed preparation, local approval, mock-backend
history across remounts, stale withdrawal, read-only recovery observation,
403 cache hiding/retry, candidate-role denial and a 390px mobile viewport.
All browser API responses were intercepted; no real sign-in, provider execution,
or committed persistence acceptance was performed. The initial stale-withdrawal
handler failure was fixed and the same tester completed the remaining journey.

The separately running combined baseline was **not green**: its meeting-notes
browser harness rejected the new meeting-assistant read requests; its Zoho
browser harness failed the missing-note-consent case with an undefined element
handle; its format gate reported drift in the pre-existing handoff renderer.
These are not passing coverage for this feature and are tracked separately.

Restarting the existing development API also triggered its existing billing-key
configuration sentinel, which sent a platform-admin alert. No billing settings
were changed. Development startup must not be assumed free of external side
effects merely because this new stage-write code is not connected.
