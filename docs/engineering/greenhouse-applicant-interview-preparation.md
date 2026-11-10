# Greenhouse applicant interview preparation

This is an implemented preparation step, **not a completed Greenhouse campaign
or automatic invitation sender**. Real-account acceptance remains with the team.
No production deployment or provider write is part of this change.

Prepared sessions now also expose a separate, explicit
[invitation review and send control](greenhouse-interview-invitation-delivery.md).
Preparation itself still never sends an email.

## Where to find it

In a work order's controlled workflow, expand an imported Greenhouse applicant
and choose **Prepare Greenhouse applicant interview**.

Prerequisites:

- An approved, active Lexy work order and employer-confirmed Greenhouse mapping.
- A reviewed, available applicant on an open, non-confidential Greenhouse job.
- A separately imported or explicitly linked canonical candidate profile.
- An active administrator of that exact employer.
- An existing nonempty job interview plan, reviewed by the administrator.

The control freezes the selected plan into a separate session plan and creates
a scheduled personal interview link. Existing sessions are retained instead of
silently replaced, including completed sessions. Native generate-link and ATS
preparation share the same per-tenant/candidate/job/interview-type mint lock.

Preparation does **not**:

- Send an invitation or first-touch email.
- Generate or change questions, models, prompts, grading or provider routing.
- Create a native application, advance a pipeline or change a Greenhouse stage.
- Publish an assessment or create, approve or deliver an offer.
- Dispatch or schedule a bulk campaign.

When existing outreach approval is bound to the applicant, use that workflow's
invitation controls; this action does not override the approval gate.

## API contract

`GET|POST /api/jobs/:jobId/candidate-workflows/:workflowId/ats-imports/:recordId/interview`

GET is local and returns private, non-cacheable preparation state. POST requires
explicit acknowledgement, the selected plan's review hash and matching
workflow/binding/import revisions. It freshly reads the exact Greenhouse job,
application and candidate through the read-only gateway. Identity, active
application, contact eligibility and canonical email must still match. Local
authorization, erasure markers and source/plan revisions are checked again
inside the final transaction.

Provider failures do not mint a session. Responses never return raw provider
payloads. No database migration is required.

The client hides cached links during failed authority reads/revalidation.
Changing the selected plan or its review hash clears the effective confirmation.

## Development evidence

Automated coverage lives in:

- `artifacts/api-server/src/lib/ats-applicant-interviews.test.ts`
- The controlled-offer/ATS development fixture in
  `artifacts/api-server/src/routes/recruiting-workflows.test.ts`

Coverage includes explicit confirmation, stale review hashes/revisions, strict
request bodies, denied roles, local-only reads, provider failure, concurrent
preparation, frozen plans, reload persistence, no contact and no native
application enrollment. Tests use synthetic development records and an injected
read-only provider stub, not live Greenhouse candidates.

## Team acceptance cases — not yet run

Use an isolated employer staging account and dummy applicant only:

1. Open preparation before importing/linking the profile. Expect an actionable
   refusal and no session, email or remote mutation.
2. Import/link the profile and select a reviewed job plan. Without confirmation,
   preparation stays disabled.
3. Confirm and prepare. Expect one scheduled personal link, no invitation
   email, no native application and no Greenhouse stage change.
4. Reload and repeat concurrently from two tabs. Expect the existing session
   rather than duplicate links.
5. Edit the original plan. The session's frozen questions remain unchanged;
   an old preparation request is rejected. Confirmations for a changed current
   plan must not silently carry forward.
6. Disconnect the employer grant or remove staff authority. Expect private
   cached links hidden after the failed fresh read and no further preparation.
7. Withdraw/reject/private-mark the remote dummy applicant or change its
   canonical email relationship. Expect refusal on fresh preparation, not a
   silent fallback to old provider data.
8. Test the personal link through the existing candidate consent/verification
   flow. Opening the link is a separate action from preparation and can invoke
   that existing verification flow.

## Engineering still remaining

Explicit per-applicant invitation approval, single-attempt sending and durable
receipts are now implemented in the separate delivery control linked above.
Reviewed [bulk campaign dispatch](greenhouse-interview-campaigns.md) now reuses
this preparation and the individual invitation sender.
[Signed SES invitation evidence and human recognition](greenhouse-invitation-delivery-evidence.md)
are now available. Legacy/other-transport invitation recovery, absent-note release, and
automatic lifecycle synchronization remain implementation work. Manual
[progress and explicitly approved assessment publication](greenhouse-interview-note-publication.md)
is implemented separately for the allocated direct connection.
[Existing-note recovery](greenhouse-note-recovery.md) is also implemented
without releasing missing-note attempts. Remaining gaps
must not be described as “only testing left.” Zoho's existing campaign path and
native Lexy hiring are not replaced.
