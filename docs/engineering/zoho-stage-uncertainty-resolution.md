# Independent human closure of uncertain Zoho stage attempts

## Purpose and limits

An uncertain provider response must not cause a resend. Read-only recovery can
show the current Zoho status, but that status does not prove which actor changed
it. Lexy now allows two current employer administrators to close the operational
hold deliberately while preserving this uncertainty.

This is a **local administrative closure**, not proof of delivery, a Zoho
eligibility certification, an ATS stage write, an offer, or permission to retry.
It does not enable the default-off execution switch.

## Staff workflow

1. Open **Settings → ATS connections → Zoho Recruit**, select the campaign and
   recipient, then find the stage-execution history.
2. If an attempt is claimed, accepted or uncertain, use its existing **read-only
   recovery** control first. Closure is available only after recovery has recorded
   `observed_target` or `observed_other`.
3. Select **Propose local closure**. Supply a meaningful reason and a non-sensitive
   evidence reference, and acknowledge both unknown delivery and no retry.
   The server reads the exact bound Zoho application again. Saving a proposal
   does not release the hold.
4. A **different current tenant administrator** selects **Independently review
   closure** within 15 minutes. The reviewer must provide their own reason and a
   different evidence reference, then approve or reject explicitly.
5. Approval records a local closure, disables further recovery on that attempt,
   and preserves its original observation state. Rejection leaves the hold in
   place. Neither outcome writes to Zoho or contacts a candidate.

Changed sources, application identity, account custody, current provider status,
or an expired proposal require fresh review/proposal; the service does not retry
automatically. A suspended or erased proposer cannot receive a later approval.
References reject sensitive credential-like content and signed/query-bearing
URLs. Do not put private document contents into reasons or references.

## What becomes possible after closure

The shared hold is released only by an independently approved closure. The old
execution command and its evidence cannot be reused for another stage write.
An approved closure also invalidates earlier prepared/approved execution
requests: any later request needs transition evidence independently reviewed
**after** closure, followed by new preparation and a separate human approval.
Normal current source, privacy, account binding, consent and execution-switch
checks still apply.

Closure itself remains available with expired transition evidence, no current
write consent, and execution disabled. It uses current **read-only** connection
custody and the same source-authority transaction as recovery. It cannot bypass
a revoked staff session or cross-employer/candidate boundary.

## Implementation and durability

- Strict API:
  `POST /api/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-execution/:requestId/resolution`.
- Body: exact request revision, current source revision, journal sequence,
  command UUID, `propose|approve|reject`, reason, evidence reference and explicit
  `confirm`, `acknowledgeUnknown`, `acknowledgeNoRetry` literals.
- The service performs a read-only provider observation under the existing
  source fence. It checks the application/candidate/job binding and source before
  journaling the proposal or review in the same transaction.
- Proposal/review commands are actor-bound and content-bound. Ambiguous outcomes
  require a refreshed history and a deliberate unchanged manual retry; command
  IDs cannot be repurposed with different content.
- Existing append-only audit envelopes retain every proposal/review. Closure
  metadata defaults to null for older envelopes. No new database migration is
  required by this feature.
- An approved closure is immutable. Late receipts cannot turn it into a
  verified/not-sent outcome. A worker that claimed before closure must recheck
  the durable closure after acquiring its source fence and cannot send later.

For deployment, keep execution disabled until **all** API/worker instances use
the new guard and matching generated API contract. Do not mix an old writer
binary with newly enabled closure controls. Production deployment remains the
team's responsibility.

## Development verification and team acceptance

Automated fixtures cover independent review, self-review denial, acknowledgements,
distinct references, stale sequences, changed provider/source identity, revoked
proposers, proposal expiry, runtime-off/expired-evidence/no-write-consent recovery,
idempotency, rejected proposals, late receipts and fresh-evidence requirements.
The isolated restart suite additionally exercises competing reviewers and
closure persistence across a PostgreSQL crash/restart with simulated upstream.

Commands:

```sh
pnpm --filter @workspace/api-server run test:zoho-stage-write
pnpm --filter @workspace/api-server run test:zoho-stage-durability
pnpm --filter @workspace/lexy run test:zoho-campaign-browser
```

These are development/simulated-provider checks, not live Zoho certification.
The browser fixture additionally models a proposal, approval or rejection
committing before a network failure, HTTP 409 or HTTP 422 response. Each
combination is exercised at desktop and 390px: refreshed history must show the
saved outcome and evidence, retain the original observation/unknown-delivery
wording, discard stale confirmations and perform no automatic repeat or resend.
These intercepted cases verify the client, not real-server transaction behavior;
the existing journal and restart checks cover server persistence separately.

The team still needs two authorized employer administrators, an isolated dummy
application and permitted read-only access for connected acceptance. Verify
proposal/review visibility after reload, unchanged remote status, no candidate
contact, retained unknown delivery wording, rejection/self-review guards, and
that a later action needs new evidence and approval. Do not induce a real
uncertain provider write merely to populate a test.
