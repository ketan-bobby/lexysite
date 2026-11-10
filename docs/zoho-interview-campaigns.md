# Employer-approved Zoho interview campaigns

For the consolidated development checks, external migration/configuration
handoff and remaining live acceptance, use [the release checklist](zoho-release-checklist.md).

## Scope

Settings → ATS connections → Zoho interview campaigns supports a saved applicant
snapshot and one explicit employer approval for the batch's first invitations.
It does not manufacture outreach interest, run native pipeline agents, change
Zoho application stages, make advancement decisions, issue offers, or approve
follow-up reminders. Those remain separate actions.

The caller and the connected account's authorizer must remain active, exact
employer `tenant_admin` users. A project connector or platform-admin role is not
employer authorization.

### Native application identity acceptance

Development live read-only checks verified that a supplied dummy job and candidate
were correctly associated even though a display-name-based application search
returned no results. A documented association read identified the application;
an exact application read then confirmed its native job and candidate IDs.
Searching by `$Job_Opening_Id` returned the same complete one-application snapshot.
Both intake previews and the campaign-source eligibility checks passed without
imports, campaign creation, invitations, stage changes or production operations.

These checks validate provider reads, not the later import/approval/send journey.
The supplied job still needs explicit local import, work-order approval and an
interview plan before a campaign can be drafted. Existing object-lookup fixtures
remain supported; native/object conflicts and non-string IDs are rejected.

## Use

1. Connect and employer-confirm the direct Zoho Recruit account. Existing grants
   created before application search permission was added require reconnecting.
2. Explicitly import a job, then approve/activate that Lexy work order. Create its
   normal interview plan with at least one question. Campaigns use that plan,
   without changing model, provider, prompt, or question-generation settings.
3. Select the job and plan and create a draft. Lexy reads actual Applications
   search results across pages, filtering by native `$Job_Opening_Id` and
   validating native `$Job_Opening_Id` / `$Candidate_Id` identities. Object
   lookup IDs remain supported, but conflicting representations fail closed.
   Display-name strings are never used as identities.
   It reads at most 100 pages × 25 applications. Incomplete, repeated, or
   oversized snapshots fail explicitly; they are never presented as all
   applicants. Duplicate applications for the same candidate get one recipient.
4. Review the saved snapshot and explicitly approve profile intake and real
   invitation emails. New applicants arriving after this snapshot are not
   covered. The approved interview plan is copied and made immutable.
5. The scheduler processes the durable queue while the server is running.
   Closing the page does not discard it. Reopen a saved campaign for progress.
6. Cancellation stops pending sends. Messages already sending or accepted by
   the email provider cannot be recalled.

Drafts store external IDs, not names, email addresses, or raw provider responses.
Contact fields are freshly read for each approved dispatch. A verified existing
ATS identity can be reused only if its canonical contact and privacy checks
still match. An unmatched same-email local profile needs explicit identity
linking through the reviewed import flow; it is not silently merged.

## Eligibility and safety

Both the local work order and remote job must remain open/approved. Remote job
states recognized for dispatch are `In-progress`, `In progress`, `Open`, and
`Active` (case-insensitive). Application states recognized are `New`, `Applied`,
`Application received`, `Associated`, `In review`, and `Screening`.
Missing/custom/terminal states require review, not guessed eligibility.

Live contract fields `Job_Opening_Status`, `Application_Status`,
`Job_Opening_Name.id`, and `Candidate_Name.id` must be verified against the
customer's account before a real campaign. No live provider acceptance is
established by synthetic tests.

Dispatch also checks current application association, account/grant revision,
staff authority, messaging kill switch, provider opt-out, canonical DNC/privacy,
erasure fences, approved job/plan content, existing interview sessions and
pre-existing workflow-owned contact. Existing workflows keep their own approval
boundary.

One durable invitation claim exists per tenant/account/job/external candidate
across campaigns. SDK automatic retries are disabled for campaign delivery.
The irreversible-attempt state is committed before the provider call. Lost or
uncertain attempts require review and are never automatically requeued.
Legacy interview re-engagement cannot send reminders for campaign sessions.

### Recipient states

- `draft`: no permission to send.
- `queued` / `preparing`: approved, not yet sent.
- `sending`: irreversible attempt recorded; delivery may be uncertain.
- `sent`: provider acceptance receipt saved, **not confirmed delivery**.
- `review_required`: interrupted or uncertain attempt; do not blindly resend.
- `blocked`: current identity, source, privacy, plan or authority check failed;
  no email was attempted by that worker.
- `simulated`: no real email was sent, including transport suppression.
- `skipped`: already reserved in another campaign.
- `cancelled`: pending recipient stopped.

There is intentionally no automatic retry or generic resend button for held
recipients. Resolve the reason and review attempt/session evidence first.

## Database rollout

Migration `lib/db/drizzle/0101_zoho_interview_campaigns.sql` adds the private
campaign tables, cross-campaign invitation uniqueness, forced RLS, erasure
barriers and frozen-plan protection. This follows the earlier Zoho account,
candidate provenance and imported-job migrations.

It was applied only to the verified local development database. Production is
externally hosted and was not modified. Apply the reviewed SQL migration chain
to the correct external target before enabling this feature there; do not use
schema push as a substitute for the security SQL.

## Verification

Regression tests are in `zoho-interview-campaigns.test.ts`, alongside the existing
Zoho provider and reviewed-import tests. They use isolated synthetic database
fixtures and an injected fake sender. The browser campaign journey was checked
with intercepted synthetic API responses, not a live Zoho login or email send.

## Human results review

### Manual reviewed-handoff download

After saving a current human decision, an employer tenant admin can choose
**Download reviewed handoff** in the applicant review screen. This downloads a
JSON snapshot for manual ATS review. It does not require a proposed stage mapping
or a working live Zoho connection.
The ATS settings screen keeps saved campaigns and local interview reviews
accessible to current employer tenant administrators even when the provider is
disconnected, awaiting employer confirmation, configuration-mismatched or failing
its account check. Server-side employer, candidate privacy and interview access
checks still apply to every read and saved human decision.

Provider-dependent access checks, imports and applicant previews remain gated
on the confirmed connection. New campaign snapshots and invitation approvals
are unavailable without it. Losing connection availability clears contact
consent and draft selections; a late response cannot restore them. Reconnecting
does not approve or send anything automatically. Saved campaign selection and
local interview review remain available across connection changes. Cancelling
an existing campaign remains an explicit local action; opening the review screen
does not cancel campaigns or recall messages.

The download itself does not contact Zoho or renew authorization.

The download uses fresh, uncached authorized review and handoff GETs, followed
by another review read. It then requires a local preparation receipt from
`POST /api/zoho-recruit/campaigns/:id/recipients/:recipientId/review-export`
and rechecks the review before starting the browser download. Scope, completed
evidence, current human decision and both review/handoff revisions must match.
A failed read, audit failure, privacy/access denial, changed evidence or
navigation/authority change prevents downloading; cached evidence is not a fallback.

The preparation endpoint independently repeats the canonical employer,
candidate-privacy and evidence checks. It appends
`zoho.review_export.prepared` to the existing tenant-scoped audit log and
returns the saved receipt. The event contains server-derived staff identity,
campaign/recipient/review references and revision hashes. It contains no names,
external ATS identifiers, contact data, transcripts, review rationale, assessment
text or exported packet. The receipt ID and preparation timestamp are included
in the downloaded file. No database migration is required.

The final insert runs in a database transaction that takes the candidate lock
also used by erasure. It checks the exact employer/staff, recipient, candidate,
session and human-review bindings, completion state, canonical erasure marker,
and scoped ATS-identity tombstone. A fresh statement after acquiring the lock
checks the bindings again: a statement that waited can otherwise retain an old
READ COMMITTED snapshot of related rows. An insert or commit failure returns no
successful receipt and is not automatically retried.

Preparation is not proof that the browser saved a file, that anyone received
it or that an ATS action occurred. Receipt delivery remains `unverified`.
An audit row can exist when its HTTP response is lost, the final evidence read
fails or the browser cannot save the file. Neither client nor server automatically
retries the preparation. Another explicit download can create a separate
preparation record; event counts must not be represented as successful-download
counts. The existing audit-log permissions and retention/erasure policies apply.

The file includes external job/application/candidate IDs as strings, the
interview reference, dated human decision/reason and explicitly advisory
job-interview assessment. It excludes answer transcripts, contact information,
recording links, private coaching and career-development data, and simulation
history. Its external IDs are saved bindings, not a fresh verification against
Zoho. No automatic ATS action, offer approval or candidate communication occurs.
Recipients must verify current employer permissions and records before acting;
the snapshot cannot establish future authority or be recalled after download.
Keep downloaded files confidential and apply the employer's retention policy.

Verification after adding preparation receipts: 15 backend service/HTTP tests,
20 frontend/download unit tests and all 22 Zoho browser scenarios passed.
The browser suite includes disconnected exports, connection loss/reconnection
that clears contact consent, late-response suppression, a local audit failure
that blocks downloading without retry, and a changed-evidence refusal.
Transport/provider responses in the browser suite are intercepted; these are
not live Zoho acceptance results.

### Real development audit-storage fixture

`artifacts/api-server/scripts/check-zoho-review-export-storage.ts` additionally
passed 12 real PostgreSQL scenarios (13 TAP tests including the fixture wrapper).
It exercises the production persistence implementation and linked-data purge,
while injecting only canonical review/handoff reads. Cases cover real audit
insertion and exact metadata, SQL insertion failure, erasure after the last
review read, lost staff access, foreign/missing/mismatched bindings, both kinds
of tombstones and unaffected peer data.

Before running it, obtain a fresh non-secret development-instance fingerprint
through the explicitly selected development database connection, using the
identity formula in the fixture. Then:

```sh
pnpm --filter @workspace/api-server exec tsx \
  --import ../../scripts/test-egress-guard.mjs \
  scripts/check-zoho-review-export-storage.ts <DEVELOPMENT_FINGERPRINT>
```

The pool must independently match that fingerprint before any DDL. A wrong
fingerprint was verified to fail closed. All table copies and writes live in
one unique private schema within an ORM transaction; its search path excludes
public, and the final rollback and independent namespace check leave no fixture
data behind. Copies preserve actual columns, defaults, checks and indexes,
and explicitly mirror the review-to-recipient cascading foreign key. They do
not recreate the complete production RLS/trigger environment.

Erasure removes the linked recipients/reviews but preserves minimal audit
identifiers under the existing compliance-retention policy. Retention does
not mean the history is fully anonymous, and an already downloaded copy cannot
be remotely erased. The fixture does not prove public-route authorization,
full account/core-profile or object-storage erasure, crash durability, a
two-connection waiting-writer race, or any production/provider acceptance.

### Reviewing evidence and recording decisions

Open a saved campaign and use its Interview review section to compare completed
job-specific interviews. The queue shows interview score (including real zero),
completion status and the latest local human review. Opening a recipient shows
only its bound campaign interview: saved questions/answers and AI assessment.
AI advice is not a hiring decision. Missing scores remain missing, and missing
AI summaries do not prevent a human from reviewing usable completed answers.

The employer administrator records **Advance**, **Hold**, or **Do not advance**,
with a required job-related reason and explicit review confirmation. These are
local review intentions: they do not move a native application, write to Zoho,
send emails, issue offers or prove that a next-round action occurred. Staff must
carry out that next-round action separately.

Corrections append another review rather than overwriting history. Every review
is bound to the exact job/interview evidence version. Changed assessment,
answers, job context or another staff decision makes an old screen stale;
concurrent saves return a conflict instead of silently replacing one another.
Changed evidence marks saved decisions as not current until explicitly reviewed
again. Repeating the same request ID/payload is idempotent.

Incomplete, empty-evidence, or truncated-evidence interviews cannot receive a
review decision from this interface. Advancement is also blocked for a job that
is no longer active. Current candidate privacy, DNC and erasure choices apply to
old results too. Recruiter comments, private development, other interview
sessions, media URLs, session credentials and raw provider payloads are not
returned by the review API.

Migration `0102_zoho_campaign_reviews.sql` adds the private, forced-RLS,
append-only review history and erasure barrier. Like the campaign migration, it
was applied only to local development; external production was not changed.

Migration `0103_zoho_campaign_dispatch_isolation.sql` separates internal
synthetic campaigns from live dispatch. Existing and HTTP-created campaigns
default to live; this does not limit real employer campaigns. The internal
test dispatcher requires an explicit tenant and injected source and delivery
implementations. Both queue claims and interrupted-attempt recovery are
lane-scoped, so an independently running app worker cannot consume synthetic
fixtures. The public campaign API rejects caller-supplied lane selection.
Apply this migration before deploying the corresponding dispatcher code;
external production has not been migrated here.

The focused review regression suite is `zoho-campaign-reviews.test.ts`. It uses
synthetic local employer/candidate/interview fixtures and checks zero/missing
scores, private-evidence isolation, explicit consent, stale/concurrent saves,
idempotency, immutable history and current privacy/authority restrictions.

## Repeatable browser checks

Run `pnpm --filter @workspace/lexy run test:zoho-campaign-browser`.
This renders the real campaign and review components with the generated API
client against intercepted synthetic responses. It checks draft creation,
snapshot-bound approval, required review acknowledgment/reason, zero and missing
scores, saved history, stale-evidence conflicts, incomplete interviews and mobile
overflow. Unexpected API requests and external network requests fail the run;
the optional font stylesheet is answered locally with empty CSS.

The command is registered as `zoho-campaign-browser` in the combined assisted
release gate. It does not connect to the app API, send emails, change Zoho, or
replace a live employer acceptance test.

Browser checks also hold draft-creation, approval and review-save responses
while the reviewer navigates away and back. Late responses must not select a
campaign, clear a newly opened form, clear its confirmation, or display a success
notice in the new view. Role, account and connection changes also invalidate the
request's display context. Leaving a view does not cancel an action already
accepted by the server: reopen/refresh the saved campaign to read its current
state, rather than assuming it failed or resending it.
