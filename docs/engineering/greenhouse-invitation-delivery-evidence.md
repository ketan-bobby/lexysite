# Greenhouse invitation delivery evidence and reconciliation

## What is implemented

Greenhouse individual invitations and reviewed campaign sends now attach
server-owned SES correlation tags for the original attempt, session, job and
workflow. No recipient address, message text, room URL or assessment is tagged.
Other mail actions, including controlled offers, retain their own tag family.

`POST /api/webhooks/ses-events` accepts correlated invitation observations only
after the existing inbound-secret check, SNS signature verification and exact
SNS topic allowlist check. Unsigned development payloads cannot bypass this
requirement. Mixed offer/invitation correlation families are refused.

The callback verifies all references against the saved claim and current
session/candidate ownership, the original recipient hash, receipt request hash
and any saved provider message ID. The first matching signed observation pins
one provider message ID. Other IDs cannot replace it.

No callback sends mail, changes approval, updates an ATS stage, changes a hiring
decision, starts employment, creates a fee or increments a recruiting-workflow
revision. Existing bounce/complaint compliance handling remains separate.

## Provider evidence is not an inbox claim

| State | Meaning |
| --- | --- |
| Unobserved | No usable signed evidence; does not establish non-delivery |
| Accepted | SES reported acceptance/processing for the exact attempt |
| Delayed | A delivery delay was reported |
| Delivered | The recipient's mail server accepted the message; not inbox placement or reading |
| Bounced/rejected/complained | A terminal failure or complaint was reported |

Duplicate observations do not duplicate the audit. Out-of-order lower-priority
observations cannot erase delivery, failure or complaint. The displayed recent
history is bounded to sixteen observations; the aggregate retains the strongest
observed state even when its event falls outside that recent window.

The UI distinguishes provider event time from the time evidence was recorded.
Neither is inferred from an unrelated mutable row's update timestamp.

## Human reconciliation

In an imported applicant's **Review invitation delivery**, open **Review signed
delivery evidence**. The same control is available on attempted recipients in
the reviewed campaign detail.

For an uncertain local result with matching signed evidence, an active,
authorized administrator of that exact employer can:

1. Review the original attempt, verified provider reference, observed state,
   event times and recent observations.
2. Check the acknowledgement for this exact evidence revision.
3. Choose **Record observed provider processing**.

This records human recognition, appends a reconciliation audit and advances the
existing receipt to an accepted local processing state. It preserves the original
claim/outcome and the independently displayed failure/delivery evidence. It never
resends, resets or releases a claim. If the local invite marker was absent, its
new time records local recognition, not a reconstructed original send time.

Replays/concurrent reconciliation save once. A changed evidence revision requires
another review. A known later bounce remains a bounce even after human recognition
of provider processing. Provider acceptance is not proof of a successful interview.

Unknown, legacy claims without the new recipient binding, simulated/suppressed,
changed-recipient and untagged attempts remain unreleasable here. Evidence cannot
be supplied by pasting an arbitrary ID or manually asserting “delivered.”

Current employer/job/applicant authorization is required for both reading and
recognition. A failed nested evidence check hides the containing cached invitation
or campaign and its private progress labels. Only a new successful containing
review restores them. Existing DNC/privacy rules can hide a bounced applicant
from ordinary workflow views; this feature does not bypass those rules.

## API and implementation

```
GET/POST /api/jobs/:jobId/candidate-workflows/:workflowId/ats-imports/:recordId/interview-invitation-evidence
```

GET is local-only and private/no-store. POST accepts only the exact original
attempt ID, current evidence review hash and explicit true acknowledgement.
Neither endpoint calls a mail/provider API.

Main files:
- `lib/interview-provider-policy.ts`: tags and bounded event parsing.
- `lib/interview-provider-events.ts`: exact correlation, deduplication, monotonic
  aggregate and erasure fencing.
- `lib/ats-invitation-evidence.ts`: current access, private evidence view and
  human-only reconciliation.
- `routes/ats-invitation-evidence.ts`: generated strict contracts and job gates.
- `WorkflowAtsInvitationEvidence.tsx`: invitation/campaign evidence control.

Paths above are relative to the API server source, except the React component
under the Lexy job components.

No database schema migration. Evidence uses existing workflow events/receipts.
Per-person binding, observation and reconciliation events are included in
candidate erasure before sessions are removed. A later callback cannot recreate
them.

## Automated test cases

| Test | Expected result |
| --- | --- |
| Wrong action or incomplete/unsafe metadata | No invitation tags |
| Malformed/ambiguous tags, date, multi-recipient event or long reference | No usable invitation evidence |
| Missing inbound secret, invalid signature, wrong topic or unsigned invocation | Rejected before invitation persistence |
| Signed event for an unknown attempt | No evidence created |
| Wrong job/workflow/session/attempt/recipient | No evidence created |
| Conflicting provider message ID | Existing binding unchanged |
| Duplicate callback | No duplicate audit/state change |
| Delivery followed by delay, or bounce followed by delivery | Stronger result preserved |
| Provider observation alone | Local uncertain receipt remains uncertain |
| Anonymous/candidate/foreign/platform reader or operator | Denied |
| False acknowledgement, forged fields or stale evidence hash | Rejected |
| Concurrent/repeated human recognition | One reconciliation, no provider calls or mail |
| Simulated attempt | Cannot acquire usable signed evidence or be reconciled |
| Candidate erasure followed by callback | No evidence resurrection |

The isolated HTTP fixture uses synthetic development records and fake mail
transport. Separate SNS HTTP tests use a private generated signing key and
mock certificate retrieval; SES SDK tests intercept the SDK before any network
call. These do not establish live AWS configuration or real inbox receipt.

The actual React controls also passed a synthetic browser journey: exact
acknowledgement-bound recognition, a 503 without automatic retry, required fresh
parent review after a failed check, persisted recognition on reload, retained
mail-server delivery evidence, no invitation/dispatch calls, nested 403 privacy
hiding for both invitation and campaign, and a 390px layout without horizontal
overflow. The success/reload check used the actual `provider_accepted` wire enum;
recognition did not downgrade the independent `delivered` evidence.

## Team acceptance still required

Use one explicitly approved dummy invitation only. In the development SES
configuration set, verify publication of the relevant Send, Delivery,
DeliveryDelay, Bounce, Complaint, Reject and Rendering Failure events to the
allowlisted signed SNS callback. Existing callback setup is reused; no security
checks should be disabled.

Confirm the real event carries the four invitation tags and matches the stored
original attempt. Compare the verified message reference with the provider's
record and the dummy recipient's received message. If a real failure is tested,
use an authorized provider test address, not a real candidate.

Do not rerun an uncertain live invitation just to generate evidence. Old untagged
attempts are not backfilled or released by this implementation. Graph/Outlook
delivery receipts and other invitation send paths require separate integration.
Production has not been accessed or modified.
