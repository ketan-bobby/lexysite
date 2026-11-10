# Reviewed interview notes in Zoho Recruit

## What is implemented

An employer tenant administrator can preview and explicitly approve:

- Interview progress only, from the campaign recipient row.
- Progress plus the assessment, from the applicant review panel, after a completed
  interview and a current human Advance/Hold/Do not advance review.

Publication creates **one candidate Note** in Zoho Recruit, with the exact job,
application and candidate IDs in the text. It is not an application-stage update.
The current Create Notes documentation explicitly supports Candidates; support for
writing application notes has not been established.

This is a **reviewed snapshot**, not automatic background synchronization.
The administrator sees the complete text and separately acknowledges publication.
Saving a local advancement decision alone does not approve assessment publication.
No raw answers, recording URLs, private coaching or candidate interview-room access
tokens are included. A staff review link, when configured, still requires sign-in
and employer access.

## Permission and activation

Read-only connections remain read-only by default. In Settings → ATS connections,
disconnect locally, select the optional interview-note creation permission, reconnect
and confirm the same employer. This requests only the additional scope
`ZohoRecruit.modules.notes.CREATE`, not record-update, stage or offer permission.
Reconnecting does not publish anything.

Renewing a separately approved note grant for the **same tenant and Zoho account**
can authorize notes about an existing campaign. It does not rewrite its original
connection reference or revive invitation sending. Changed accounts cannot receive
the old campaign's notes. Renewing a grant invalidates an outstanding preview
approval, but does not permit duplicate publication of already-acknowledged text.

No live publication, permission upgrade or production change is performed by the
development tests. A live dummy-record acceptance check remains separate.

## Acknowledgment and failures

The publisher rechecks active employer authority, current connection ownership,
the exact remote application/job/candidate association, local privacy and erasure,
and current interview/review evidence. Candidate, reviewer, session, summary and
account locks protect the final dispatch. Source rechecks and receipt persistence
use that same transaction connection rather than borrowing another pool connection
while locks are held.

A committed, serialized attempt claim precedes the single provider POST. There are
no automatic retries or redirects. Duplicate approvals return the existing receipt.
A new milestone or a newly approved assessment can produce a new snapshot.

“Zoho acknowledged” means the Create Notes response included a successful note ID.
It does **not** mean an independent read-back was performed, nor that an employer
read the note.

If a request times out, the response cannot be validated, local receipt persistence
fails, or an attempt is interrupted, the claim remains **unconfirmed** and further
publication for that recipient is blocked. Inspect Zoho before doing anything else.
There is not yet an in-app reconciliation/clearance action; do not clear claims or
resend by editing the database. A read-back and reviewed resolution workflow is
follow-up scope.

Local audit receipts retain hashes and identifiers, not copied assessment text.
Published notes are employer-held external records subject to Zoho permissions
and retention. Lexy does not promise automatic external-note deletion on erasure;
an employer must include its Zoho notes in its external-record privacy process.

## Unchanged boundaries

- No Zoho hiring-stage change, automatic rejection, offer or employment action.
- No changes to interview models, prompts, providers or routing.
- Notes are visible to Zoho users who can access that candidate's Notes; staff
  must review that disclosure before publication.
- Existing invitations and stage-handoff simulation approvals remain separate.

References: Zoho Recruit v2 Create Notes and Get Notes documentation,
https://www.zoho.com/recruit/developer-guide/apiv2/create-notes.html and
https://www.zoho.com/recruit/developer-guide/apiv2/get-notes.html.
