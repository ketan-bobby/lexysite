# Candidate erasure: late-write protection

## Implemented

An additive database migration installs a write barrier on the 60 current
candidate-linked tables, the candidate and sourcing rows, the AI queue and the
three known indirect interview/workflow child tables. Required legal/audit
records remain outside the destructive cascade. Retained applications can
record only the narrowly scoped candidate-withdrawal update after erasure.

Minimal suppression identifiers survive hard deletion, including sourcing aliases
captured by the shared cascade. They contain no names, emails, résumé text or
provider response payloads. Candidate IDs with historical soft-erasure markers
or committed durable erasure receipts are seeded without altering live profiles.

Child writers lock their candidate before persisting. An erasure that owns that
lock prevents a waiting stale writer from succeeding after commit. Conversely,
an earlier writer must finish before erasure can snapshot and remove its result.
Concurrent updates can produce a PostgreSQL deadlock; PostgreSQL aborts a
transaction rather than committing stale data. Existing failed erasure requests
must be investigated/retried, not reported as complete.

Erasure atomically discards candidate-linked queued/running/completed AI job
snapshots and deduplication text. Minimal candidate IDs remain with a terminal
privacy-discard reason. Enqueue and worker preflight check erasure, and late
completion/failure updates require a still-processing queue row. Résumé work
checks before downloading and merging; a final database barrier covers results
that were already computing. Structured privacy-barrier errors omit SQL
parameters so blocked private results are not copied into error logs.

The canonical outreach dispatcher rechecks the message and candidate immediately
before calling the mail provider. This is a fresh check, not an atomic
provider-delivery guarantee.

## Verification

28 focused checks passed across the completed runs:

- Seven late-write/privacy tests: soft and hard erasure, old-ID reinsertion,
  queued/running discard, late completion/failure, remaining live peers,
  ordinary application-role enforcement, rollback, a waiting-writer race,
  and error-log parameter suppression.
- Nine real erasure-controller/cascade tests.
- Five candidate-account/authentication tests.
- Seven durable file-cleanup/confirmation recovery tests.

Database schema compilation, API build/security guards and the extended
cascade/write-barrier drift check passed. The drift check now fails when a
required enabled write-barrier trigger is missing. Focused tests use disposable
records, future-dated queued jobs and blocked external egress, not real Linx
accounts or live provider deletion.

## Deployment and remaining boundaries

Apply `scripts/sql/2026-10-11-candidate-erasure-write-barrier.sql` to each correct
data-region database before deploying dependent code. Do not use a full schema
push: it can remove security layers. The migration was applied to the configured
workspace API database; production migration is not implied by publishing.

- Already-accepted provider requests cannot be recalled by these checks. A
  provider handoff racing the final read remains a separate delivery-control gap.
- Historical hard erasures without a durable receipt, and source aliases already
  removed before the registry existed, need a scoped audit before any backfill.
- The barrier suppresses old identifiers; it is not an email blacklist and does
  not forbid a genuinely new, consented account/profile.
- Late presigned uploads and physical AWS byte-deletion verification remain
  parked. No live AWS deletion proof was performed.
- Independent vendor-held copies and retained legal histories are not certified
  erased by this barrier. AI prompts, models, providers and pricing are unchanged.
