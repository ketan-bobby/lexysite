# Greenhouse interview progress and assessment publication

## Implemented behavior

For an imported Greenhouse applicant with an explicitly prepared Lexy interview,
the exact employer's administrator can open **Review Greenhouse write-back**
inside the interview preparation panel.

- **Interview progress only** previews local invitation acceptance and interview
  state/timestamps. Invitation acceptance is not described as inbox delivery.
- **Progress and assessment for approval** additionally includes the completed
  job-interview score, summary, recommendation, strengths, development areas and
  concerns. It requires a completed/reviewed session, completion timestamp,
  answers, a nonempty job plan and a valid stored assessment.
- The administrator sees the exact proposed text, checks an explicit approval
  box, then chooses **Approve and publish one note**.
- A saved hiring decision, plan approval, invitation approval or selecting
  assessment mode does not itself authorize disclosure.
- Notes are created with Greenhouse's `NOTE` classification, scoped to the exact
  candidate and application and restricted to `admin_only` visibility.
- This action never advances/rejects an applicant, creates an offer, confirms
  employment or sends a candidate email.

No transcript, recruiter-private comments, private career/coaching data,
recordings, interview room links or session access capabilities are included.
URLs in selected assessment narrative fields are omitted. Zero scores remain
zero. Oversized notes are refused rather than silently truncated.

This is **manual per-applicant publication**, not automatic lifecycle sync or a
bulk campaign. The displayed AI assessment is not an independently corroborated
identity check or a final human advancement decision. Publication approval is
explicit disclosure approval, not hiring-decision authority.

## Transport and permissions

Read-only Greenhouse methods remain read-only. A separate fixed-purpose direct
transport performs exactly one `POST https://harvest.greenhouse.io/v3/notes`.
It accepts only bounded candidate/application note fields, `NOTE` type and
`admin_only` visibility. It cannot forward arbitrary hosts, stages, offers,
emails, authors or caller-chosen request fields.

Initial note writes support the **allocated direct Greenhouse connection**.
The existing managed connector remains usable for its read-only functions;
write-back is unavailable for it rather than silently using different credentials.
The direct client's Greenhouse grant must permit note creation. Local transport
availability is not proof that the provider granted that permission.

The existing optional `GREENHOUSE_CLIENT_ID` / `GREENHOUSE_CLIENT_SECRET`
configuration is used; no secret or permission changes were made for this work.
Its single-account-per-deployment limitation remains. Exact employer allocation
and fresh administrator approval are still required even when credentials exist.

Authoritative API reference:
https://harvestdocs.greenhouse.io/reference/notes

## API

- `GET /api/jobs/:jobId/candidate-workflows/:workflowId/ats-imports/:recordId/interview-note/:mode`
  where mode is `progress` or `assessment`: private local preview, no remote write.
- `POST /api/jobs/:jobId/candidate-workflows/:workflowId/ats-imports/:recordId/interview-note`:
  strict `{ mode, reviewHash, acknowledge: true }`.

The review hash binds the current employer/account/workflow/import authority,
candidate identity, prepared session, plan, source evidence and exact note.
Publication freshly verifies the exact provider job, application and candidate.
Closed, changed, hidden, erased, DNC or unavailable source data prevents contact.
Privacy is re-evaluated after source locks, before protected provider I/O.

The UI hides cached note content on failed authority reads or revalidation.
Changing mode remounts the review and clears its approval.

## Durable receipts and uncertainty

Existing workflow receipt/audit tables store a committed claim before the provider
write. No database migration is required. The exact content gets one
session/account/application-bound receipt. Concurrent requests and replays reuse it.

A published result requires a matching provider response: note ID, candidate,
application, type, visibility, subject and body must agree. The transport uses
bounded responses, timeouts, pinned hosts, credential identity rechecks, no
redirects and no automatic write retries.

Exceptions, response mismatches and interrupted finalization remain held.
An unresolved attempt blocks both identical retries and changed-content
publication for that interview. There is no automatic claim release.
[Evidence-based existing-note reconciliation](greenhouse-note-recovery.md) is now
implemented. It verifies an existing exact note; absence never releases a claim.

Only hashes and opaque source/attempt/note references are retained in the local
publication audit, not a duplicate note body, transcript or raw provider error.
Candidate erasure removes the indirect local claims, outcomes and receipts.
Deleting a local candidate does **not** delete a note already published in the
employer's external ATS; external erasure obligations require separate handling.

## Verification

Development checks use synthetic records and mocked/injected provider operations:

- Direct transport validates the fixed POST/payload and matching receipt;
  broad or managed-connector write attempts are rejected.
- Ambiguous provider responses are not retried.
- Private-source exclusions, URL removal, zero-score preservation and invalid
  assessment rejection are covered by policy tests.
- Real development-database HTTP fixtures cover local previews, role/tenant gates,
  false approval, unknown payload fields, stale assessment approval, unavailable
  transport, provider failure/changed applicants, concurrent publication,
  persisted results, replay, completed-assessment publication and uncertain-write
  changed-content fencing.
- Erasure assertions verify indirect receipt/event removal through the session.
- API build/security guards, frontend typecheck and changed-file lint pass.
- A browser run mounted the actual component with intercepted synthetic APIs:
  expansion never published, assessment mode reset progress approval, the exact
  approved payload was submitted once, publication survived reopening, and 403
  failures/unavailable permissions hid private content and publishing controls.
  That run found a narrow-screen selector overflow; the selector was changed to
  a stacked, explicitly width-constrained layout.

These checks do not establish live Greenhouse permissions or real-account
acceptance. No live provider write or production operation was performed.

## Team acceptance — not run

1. Allocate/confirm a dummy employer's direct connection with note permission.
2. Import and prepare its dummy applicant, then preview progress without publishing.
3. Confirm the note contains the correct external job, application and candidate.
4. Approve one progress note; verify its content and admin-only visibility in
   Greenhouse. Reload/replay and confirm no duplicate.
5. Complete the dummy interview. Review assessment text and explicitly approve
   disclosure; confirm no stage, offer or candidate email changes.
6. Change the assessment after preview; confirm the old approval is rejected.
7. Revoke staff authority or mark the candidate unavailable; confirm private
   content is hidden and publication refused.
8. Exercise a simulated uncertain response in the isolated test environment;
   confirm new content cannot bypass the hold. Never manufacture a timeout on
   real candidate records.

## Remaining scope

[Reviewed applicant campaigns](greenhouse-interview-campaigns.md) are implemented
separately and do not authorize assessment disclosure. Automatic progress scheduling, managed-connector note
writes, legacy/other-transport invitation recovery, absent-note resolution and live team
acceptance remain separate. Native Lexy hiring, Zoho publication and human-operated
offers are unchanged.
