# Durable erasure file cleanup — 11 October 2026

## Behaviour

All three erasure paths persist a server-derived file receipt in the same
transaction as database erasure. If snapshotting or receipt persistence fails,
the cascade rolls back; files are never deleted before database commit.

After commit, a fenced lease allows one worker or authorised platform-admin
retry to process a request. Each successful target is checkpointed, its filename
removed from the receipt and replaced by a proof hash. Failed targets keep their
references. Missing-client and provider failures remain retryable, with backoff
from one minute to six hours. The scheduler processes at most five due requests
per tick on the existing scheduler leader.

Requests remain `in_progress` until file cleanup completes. The admin queue shows
remaining targets, attempts and issues, polls for progress, and provides a retry
button. Candidate request views receive summaries, not file paths or lease data.
Unsupported remote references and broad prefixes require review and cannot
trigger arbitrary deletion. Concurrent requests for an already-pending subject
must recover its existing receipt rather than lose its references in a second
snapshot.

Only an admin-reviewed request requests a completion email. Self/staff legacy
anonymisation does not add a new email. The email dispatch claim is durable
before the provider call. A crash or uncertain provider result leaves delivery
marked `uncertain`; it is not automatically resent. This is at-most-once
dispatch, **not** a guarantee of exactly-once email delivery.

Denial is restricted to a still-pending request with no cleanup receipt;
operators cannot deny a committed erasure while its worker is cleaning files.

## Migration

The additive migration is `scripts/sql/2026-10-11-erasure-cleanup-outbox.sql`.
It was applied to the configured workspace API database without a schema push,
data backfill, grant changes or RLS replacement. Apply the same migration to the
correct database before deploying this schema; publishing must not be assumed
to migrate an external database.

Historical requests without receipts are not automatically reconstructed or
processed. Their existing audit records require separate review. No real Linx
records were backfilled or erased.

## Verification boundary

Final focused run: **16 tests passed**, including the actual erasure and retry
HTTP controllers, authentication/role denials, stale-owner fencing and duplicate
subject receipts. Frontend typecheck, API build/security guards, 60-table schema
drift check and formatting passed. Lint had zero errors and 500 warnings.
Both app workflows restarted; the cleanup scheduler logged its startup and the
public login screen rendered. Protected UI interaction was not browser-tested.

Startup also surfaced the existing dormant-Stripe configuration sentinel and
its platform-admin alert. Billing was not enabled or reconfigured. Test storage
and completion emails remained mocked; no live AWS deletion proof was performed.

Focused tests use disposable receipts and populated candidate fixtures, blocked
external HTTP, mocked storage and mocked email acceptance. They cover rollback,
constructor failure, partial progress, recovery, competing owners, uncertain
email recovery, restricted references, peer isolation and summary privacy.
Live AWS byte-deletion proof remains parked; late uploads from previously issued
presigned URLs remain the documented residual risk in the deletion runbook.
Eligible candidate-only account closure is covered by
[the account-closure checks](candidate-account-closure-2026-10-11.md).
Shared-profile/cross-region closure and broader background-data resurrection
remain separate review work. AI models, prompts, providers, pricing and sourcing
are unchanged.
