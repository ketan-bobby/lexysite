# Greenhouse reviewed interview campaigns

## Scope and location

In the work order's candidate workflow, open the reviewed Greenhouse imports.
The **Greenhouse interview campaign** panel prepares and runs an explicitly
selected set of already linked applicants. It does not silently import profiles,
merge people, enrol future applicants or change Greenhouse stages.

This extends, rather than replaces, individual applicant interview controls.
Native Lexy hiring remains separate and available.

## Operator flow

1. Confirm the employer-owned Greenhouse connection, allocation and work-order
   approval. The operator must be an active tenant administrator of that exact
   employer; platform administration is not an employer authorization.
2. Explicitly review/import/link each selected applicant's canonical profile.
3. Select up to ten distinct imported applicants and one saved, nonempty job
   plan. Acknowledge private link preparation, then **Prepare batch preview**.
   This may prepare frozen private interview sessions but never emails anyone.
4. Review each actual recipient, subject, complete message and interview state.
   A separate acknowledgement and **Approve batch** approve precisely this
   immutable snapshot. Approval itself sends nothing.
5. **Run approved batch** deliberately sends the remaining ready recipients one
   at a time. The browser must remain open. Neither opening a campaign nor
   reloading the page starts delivery. Ten is a bounded operational batch size,
   not a subscription, spending or paywall limit; further batches are allowed.
6. Reopen a recent saved campaign after navigation or reload. Existing per-session
   receipts remain authoritative. Run only remaining ready recipients deliberately;
   a blocked pre-send request needs its own single-recipient action.
7. **Stop after current** only stops this browser's loop. **Cancel remaining**
   records an employer-wide durable cancellation. Neither can recall messages
   already accepted by the mail provider or a send already in flight.

The recent list contains up to twenty campaigns with an explicit truncation
notice. Its selection size is the original audited selection, not the current
number of privacy-visible or send-eligible applicants. Current per-member detail
hides unavailable/private identities and prevents dispatch.

## Authority, changes and progress

- Preparation preserves existing interview mint idempotency, frozen-plan checks
  and fresh remote job/application/candidate verification. Existing sessions from
  another import or another plan are not adopted, replaced or reset.
- Failed multi-person preview preparation can leave valid private sessions for
  earlier members. Repeating the same request reuses them; no campaign has been
  approved and nobody has been emailed.
- Batch approval hashes the source authority, job/plans and immutable membership
  containing the original per-message hashes. It is not a standing automation policy.
- Every dispatch reuses the single-invitation sender, claim and session-wide
  receipt. An individual send and two campaigns cannot independently resend the
  same interview.
- Batch approval and current employer authorization are checked at every existing
  invitation read/claim/final transport boundary, under the cancellation lock.
  The original approving administrator must also remain active and authorized.
- Source/recipient/content changes, erased or unavailable members, changed
  approval authority and frozen-plan changes stop remaining batch sends. Prepare
  a new batch of eligible, unsent applicants; do not silently reapprove or replace
  old messages.
- Provider acceptance is **not** inbox delivery. Uncertain and simulated attempts
  remain held, with no automatic retry, restart or campaign-level reset.
  [Signed SES evidence and human recognition](greenhouse-invitation-delivery-evidence.md)
  are available on attempted members. Recognition does not resend or resume a batch.
- Known pre-claim blocks have durable, generic per-member diagnostics and can be
  deliberately retried if the same approval and current eligibility still hold.
  Raw private provider errors are never stored or returned by these diagnostics.
- Invocation errors invalidate the UI's current authority. Recipient/message and
  historical progress labels stay hidden during failed or pending fresh reads.

## Storage and API

No new database schema or migration. Existing workflow events hold the campaign
root, approval/cancellation and per-session membership/blocked diagnostics.
Per-person metadata contains opaque record/session references and message hashes,
not copied email addresses, message bodies, room URLs or provider payloads.
Candidate erasure removes indirect per-person campaign events before sessions;
remaining root hashes cannot authorize contact with missing members.

All endpoints are private/no-store, job/workflow scoped and employer-admin gated:

```
GET/POST /api/jobs/:jobId/candidate-workflows/:workflowId/ats-interview-campaigns
GET      .../ats-interview-campaigns/:campaignId
POST     .../ats-interview-campaigns/:campaignId/control
POST     .../ats-interview-campaigns/:campaignId/members/:memberId/dispatch
```

POST bodies are generated from OpenAPI, strict and require explicit true
acknowledgement in server logic. Callers cannot supply email content or recipients.
Control supports approve/cancel only. There is no campaign restore, cron runner,
general-purpose email endpoint, Greenhouse write, hiring decision or offer action.

Implementation: `ats-interview-campaigns.ts`, `ats-campaign-store.ts` and
the campaign router in the API; `WorkflowAtsCampaign*.tsx` in the job UI.

## Automated development evidence

The isolated HTTP fixture uses temporary development records, a fake Greenhouse
gateway and fake mail transport. It covers:

| Case | Required result |
| --- | --- |
| Anonymous/candidate/foreign/platform caller | Denied; no preparation/contact |
| False acknowledgement, duplicate/empty/forged selection, changed plan hash | Rejected |
| Concurrent identical preparation | Same saved campaign and private sessions |
| Same preparation key, different selection | Conflict |
| Preview or approval alone | Zero mail transport calls |
| Dispatch before approval | Conflict |
| Candidate DNC after preview | Identity hidden; approval blocked |
| Cancellation during provider verification | No later send claim or transport |
| Concurrent approval/dispatch or replay | Original session sends at most once |
| Known provider read failure | Durable blocked state after reload, no mail |
| Deliberate retry with uncertain transport | Held; no subsequent resend |
| Candidate erasure | Indirect member events removed, identity hidden, remaining execution stopped |

The existing controlled-offer/ATS/invitation/note recovery regression fixture
continues to run alongside these checks.

A browser pass using the actual campaign components with intercepted synthetic
API responses also passed: explicit preparation/approval, two sequential sends
from one Run, reload without automatic dispatch, explicit blocked-recipient
retry after a 503, cancellation, 403 privacy hiding (including progress labels),
source-changed member hiding after recovery, and 390px layout without horizontal
overflow. This proves UI behavior, not real account connectivity or inbox
delivery. UI preparation-key retry reuse and optional scope switching were not
exercised by that browser pass; server preparation concurrency was checked by HTTP.

## Deferred team acceptance

Real Greenhouse account permissions, provider records, mail inbox receipt and
signed-in employer operation still need an authorized team pilot. Development
fixtures do not establish those facts. Use approved dummy applicants only:

1. Prepare two linked dummy applicants with the same approved plan; confirm no email.
2. Inspect both complete messages; approve; confirm no email.
3. Run; verify exactly one invitation per dummy recipient in the target inbox.
4. Reload; verify progress persists and repeat Run cannot resend accepted members.
5. In a fresh batch cancel before running; verify no invitations.
6. Confirm a real completed dummy interview's progress is visible without exposing
   assessment content that has not been separately approved for publication.
7. Try an unauthorized account and a different employer: no private details or actions.

No production access, live candidate invitations or Greenhouse writes are part
of the automated checks.
