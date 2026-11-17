# Zoho employer transition evidence

## Implemented in development

Tenant administrators can propose evidence for one application's exact current-to-target
transition, and a **different currently authorized tenant administrator** can independently
verify that evidence. This is employer-human attestation, **not** a Zoho-certified
allowed-next-actions API result. No real employer rule has been established by synthetic
tests, and no live stage update is enabled by this feature.

Find **Application transition rule evidence** within the existing campaign recipient's
stage-request workspace. Read access reuses the current employer, candidate privacy,
job, assessment and human-decision gates. The current application/candidate/job IDs
are shown for review; these raw provider IDs are not automatically copied into the journal.

### Employer evidence, not a generic checkbox

The submitter supplies four distinct non-sensitive, version-specific document/report
references covering:

1. The supported candidate+job Change Status contract for the exact transition.
2. Isolation to the application, candidate and job under review.
3. Blueprint and mandatory-field requirements.
4. Automatic messages and cross-application side effects.

The independent reviewer must actually inspect those references and record a separate
review reference. Lexy does **not** fetch referenced URLs or certify their contents.
Use stable report/version references, not mutable “latest” pages, candidate personal
data, credentials, signed URLs or document uploads. Synthetic report labels in tests
are not acceptable evidence for real execution.

Only transitions requiring **no additional mandatory fields or Blueprint actions** and
**no automatic messages or cross-application changes** are representable here.
Unsupported behavior remains blocked, not bypassed. A default status catalogue match
is checked for consistency but is never promoted into transition eligibility.

### Server authority and storage

The server derives employer/account, credential custody/configuration, source
connection, candidate/application/job binding hash, mapping, current human decision,
source evidence and from/to statuses. Client proof objects and authority fields are
rejected. Submit and verify explicitly perform bounded read-only provider validation;
ordinary GET reads stay local.

Proposals require both the current source revision and the exact current rule revision
(or null for the first proposal). A new proposal supersedes the previous rule. Every
verify/revoke action compares the exact rule revision again after obtaining the source
authority locks. Commands are idempotent by actor, scope, request ID and exact payload;
reusing a command ID for different input fails.

The existing append-only audit journal stores a versioned, bounded, sequence-linked
history with immutable evidence and reviewer provenance. Source identifiers use hashes,
not automatically serialized raw provider IDs. Stored references must remain
non-sensitive. No database migration, new credential or production change was added.
Malformed, incomplete or oversized history fails closed.

Verification expires **15 minutes after independent review**, without automatic renewal.
Unreviewed proposals expire after 24 hours. Revoked, superseded, stale or expired evidence
cannot be used. Both submitter and verifier must still be active employer tenant admins
when the server-only proof loader is used; these checks hold SQL row locks.

`zohoStageRules().withVerifiedRule(...)` is a server-only callback loader, not a route
that hands a reusable authority token to a browser. It performs fresh read-only metadata
validation, rechecks the current journal and source bindings within the existing SQL
authority transaction, locks reviewer authority and supplies the bounded proof while
that transaction remains held. Future execution must use this same transaction and
recheck expiry immediately before provider I/O. It must not cache a returned proof or
re-enter pooled source reads while holding the transaction.

### API

Paths below are relative to `/api`:

- `GET /zoho-recruit/campaigns/:id/recipients/:recipientId/stage-rules`
- `POST` the same path to propose evidence.
- `POST .../stage-rules/:ruleId/actions` for **verify** or **revoke** only.

All bodies are strict; timestamps, source bindings, actors, verification flags and
expiry are server-owned. Responses are `Cache-Control: no-store`. Public workspaces
continue to return `liveEnabled:false`; there is no execute/send/retry action.

## Local verification and limitations

On 2026-11-15, **106 focused Zoho checks passed**, with no failures or skips,
including the 14 checks in the new evidence-review test file. API/client generation,
shared-library checking and the web typecheck passed. The signed-in admin UI and
real employer evidence were not manually exercised in that run.

The regression file `zoho-stage-rules.test.ts` exercises real journal/reviewer SQL
in private temporary tables on a verified local development database, then rolls back.
It covers independent review, proof lifetime, role revocation, source/custody/catalogue
drift, strict input, replay, supersession, scope/privacy denial, malformed history and
HTTP route behavior.

Concurrent proposal and review tests use a serialized injected source fence plus real
SQL journal operations. They prove the service repeats optimistic-concurrency checks
inside the fence, **not** production capacity, distributed failover or multi-instance
provider behavior. The existing authority/connection/ledger suites separately exercise
the underlying fences and transport. No test creates a real employer verification or
contacts candidates/Zoho.

## Still open

- Establish genuine employer-specific evidence and independent review.
- Complete separately authorized, isolated dummy write/read-back and deployment acceptance.

The [controlled-execution integration](zoho-controlled-stage-execution.md) now
binds this loader, the transport and ledger to separate preparation, approval
and execution controls. Existing local approvals cannot become execution consent.
Runtime execution defaults off. Evidence review's `liveEnabled: false` describes
this non-executing evidence workflow, not the separate execution workspace's
activation state. This document does not claim live Zoho acceptance.
