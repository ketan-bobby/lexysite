# Greenhouse interview invitation delivery

## Implemented scope

An exact employer administrator can review and explicitly send one invitation for
an interview prepared from a reviewed Greenhouse applicant. This is a manual,
single-applicant action, not a bulk campaign or autonomous dispatch.

In the work order's controlled workflow:

1. Expand the imported applicant.
2. Open **Prepare Greenhouse applicant interview** and prepare the existing plan.
3. Select **Review invitation delivery**.
4. Review the recipient, subject, full invitation text and interview guidance.
5. Check the authorization box and click **Approve and send one invitation**.

Merely opening the view, preparing a link or checking the box sends nothing.
The email uses the existing Lexy-branded transport and shared interview guidance.
The employer remains responsible for hiring decisions.

## API and authority

`GET|POST /api/jobs/:jobId/candidate-workflows/:workflowId/ats-imports/:recordId/interview-invitation`

- GET is a local, private, non-cacheable review. No provider call or email.
- POST requires explicit acknowledgement and the current review hash. Unknown
  fields, including caller-selected recipients, are rejected.
- Job, workflow, employer grant, applicant, canonical identity, privacy/erasure
  rules, frozen plan and current email content are bound to the review.
- Only the imported applicant's own prepared, scheduled session is sendable.
  Native/pre-existing unrelated interviews are not adopted.
- Existing outreach approval and employer messaging-disable controls are honored.
- Fresh read-only Greenhouse job, application and candidate checks must succeed
  before the durable claim. Changed or unavailable provider data blocks contact.
- A final locked local authority check happens after the durable claim and
  before the transport call.

The browser hides cached recipient/message data during revalidation or authority
failure. Mutation and transport retries are disabled.

## Durable outcomes and safety

The existing workflow receipt table holds a unique per-session claim committed
**before** the email call. Approval claims and outcomes are separate audit events.
No database migration is needed.

| UI status | Meaning |
| --- | --- |
| Not sent | No tracked attempt or legacy invitation exists; sending still requires eligibility and approval. |
| Provider accepted | Transport returned success and a message ID. This is not inbox delivery or a candidate read receipt. |
| Review required | Claimed/in-flight/interrupted send, transport exception or ambiguous result. Never automatically retried. |
| Simulated | Transport explicitly simulated or suppressed the email. No real delivery is claimed. |
| Previously sent | Existing session invitation timestamp prevents a duplicate send. |

Concurrent requests and later retries reuse the saved claim; they do not call the
transport again. A crash or database rollback after provider acceptance leaves
the earlier claim held rather than permitting another email.

There is intentionally **no automatic expiry or release of a claimed attempt**.
Manual evidence-based reconciliation/release controls are not implemented here.
Do not delete receipts to force a resend. Simulated attempts also remain held.

Only approved hashes, session/import references and provider message IDs are
retained in the workflow audit, not email bodies or raw provider errors. The
preview always shows current details, not a historical copy of a sent message.
Candidate erasure removes indirect invitation claims/outcomes and receipts even
when the imported person's workflow root belongs to another candidate.

## Verification performed in development

- Unit policy checks distinguish accepted, simulated, suppressed and uncertain
  transport responses.
- Existing real-development-database HTTP fixture uses injected Greenhouse reads
  and injected email transport, with synthetic candidates only.
- Checks cover missing approval, forged recipient fields, stale hashes,
  unauthenticated/candidate/foreign/platform callers, provider failure and changed
  application status, concurrent sends, request replay, saved acceptance,
  thrown transport errors, simulation, and indirect erasure cleanup.
- API build/security guards, frontend typecheck and changed-file lint passed.

No live candidate invitation, Greenhouse write, production access or model/prompt
change is part of these tests.

## Team acceptance cases — not run

1. With an authorized dummy applicant, confirm the recipient and prepared room link.
2. Open and close review without sending; confirm no email.
3. Change the plan/job/applicant after review; verify fresh approval is required.
4. Disable employer messaging; verify sending is unavailable.
5. Explicitly approve one dummy invitation; verify the branded email and link.
6. Reload or repeat the request; confirm no duplicate email.
7. Revoke employer authority; confirm cached recipient/message details disappear.
8. Complete the interview; confirm it cannot be newly invited through this control.

## Still separate

Manual per-applicant [progress and approved assessment note publication](greenhouse-interview-note-publication.md)
is now implemented for the allocated direct Greenhouse connection.
[Reviewed batch dispatch](greenhouse-interview-campaigns.md) is also implemented,
reusing this session-wide single-send receipt.
[Signed SES delivery evidence and human recognition](greenhouse-invitation-delivery-evidence.md)
are now implemented for newly tagged Greenhouse attempts. Unknown/legacy attempt
release, other mail transports and real provider acceptance remain separate scope. Existing-note
[reconciliation](greenhouse-note-recovery.md) does not prove email delivery.
Native hiring and controlled
offers are unchanged. Real-account acceptance remains with the team.
