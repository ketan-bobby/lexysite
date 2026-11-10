# Lexy code handover — current scope

Snapshot: **2026-11-10**. This is a development handover for controlled IT
acceptance, **not permission to launch production or contact real candidates**.
Use this sheet over older “remaining gaps” paragraphs that predate recent work.
Verification results belong in
`docs/qa/code-handover-closeout-2026-11-10.md`.

## Final handover increment

### Latest authentication increment

Read `All-Device-Signout-Verification.md` first. Password-confirmed self-only
all-device sign-out is available in staff and candidate settings. It atomically
records private security evidence and revokes all prior account sessions without
changing the password. Ordinary logout is still session-specific. Apply
**0113 → 0114 → 0115** before coordinated API cutover; the latest report supersedes
older test totals and deployment prerequisites. Only development was migrated.
Organization-only SSO accounts have no password-confirmation bypass.

### Earlier increment: password changes and replica proof

Read `Credential-Session-Replica-Verification.md` before earlier same-date
reports. Account-wide password-change invalidation and multi-process/restart
revocation are now implemented and locally verified. Normal logout remains
session-specific. Apply migrations **0113 then 0114** to the identity/control
database and coordinate all API replicas during cutover. Quiesce password
changes/session issuance while old binaries are being replaced. The pack
includes all three SQL files; production has not been modified.

### Earlier same-day increment: session revocation and manual handoff

Read `Session-Handoff-Contention-Closeout.md` for the earlier increment. Logout now
revokes the selected credential server-side; copied cookies/bearers are denied
while independent same-account logins remain valid. Explicit failed logout is
visible and retryable. The employer-owned manual handoff now has an audited,
snapshot-bound human-reported record after approval/export; it is not an ATS
receipt or an offer. Bounded isolated campaign contention/recovery passed.

**Deployment prerequisite:** review/apply
`lib/db/drizzle/0113_session_revocations.sql` to the identity/control database
before deploying all API replicas. Applied only in development here. Earlier
email-only no-migration and cookie-only logout statements below are historical,
not instructions for this build.

Repeatable verification now includes the required Mail Holds browser regression
(5/5 scenarios passed) and an opt-in full-stack native-cookie runner (nine denial
scenarios, 27 denied resource requests, each with an authorized independent
control). See `Mail-Holds-Automated-Verification.md` for that earlier evidence.
The latest session-revocation report supersedes its cookie-only logout boundary.
Production has not been checked or migrated.

- Platform administrators can open **Mail Holds** at `/platform/mail-holds`,
  record a ticket/receipt reference and retain or close a review **without
  resending**. Both outcomes retain the original pending send hold.
- Reviews are append-only, actor-attributed and version-checked. They are not
  provider acceptance/delivery proof and do not authorize a resend or release.
  Only recorded replies, reminders and candidate cadences are included; separate
  offer, erasure, post-hire claim and outreach-attempt ledgers are not unified here.
- Missed private weekly bell recaps recover from bound accepted receipts, with
  original reporting dates and no duplicate email. Historical metrics are not
  reconstructed from today's learning state.
- No new database migration, production action, AI configuration change or paid
  pilot restriction is part of this increment.
- **Source-Version.json** in the download pack records the base Git revision,
  exact allowlisted code/config/schema file hashes and a combined source digest.
  The base revision alone does not describe uncommitted work. Match the digest,
  not only the revision, when choosing the frontend/backend for IT testing.
  Media assets, ignored files, secrets, development data and generated binaries
  are outside that source digest; it is not a production-image attestation.
- Non-blocking visual observation for IT: the phone screenshot showed possible
  left-edge navigation overlap during a drawer transition. Review the settled
  open/closed drawer states on a phone; desktop review contracts passed.

## 1. What IT is receiving

The application source and lockfile are in the project repository/workspace.
The downloadable pack contains documentation, editable acceptance cases and
inventories; it is not a source-code archive and contains no credential export.
Use the same reviewed source version for API, frontend and migration review.
Do not deploy generated development fixtures or copy development data to production.

| Area | Implemented development scope | Still requires separate acceptance |
| --- | --- | --- |
| Native hiring | Screening, verification review, interest/reply handling, interviews, evaluation review, human hiring decisions and controlled offers | One attributable LINX staff/candidate workflow; no synthetic sign-off as real identity/assessment evidence |
| Sourcing | Internal rediscovery, external provider adapters, enrichment, receipts and workflow controls | Authorized live account/provider results; invoice reconciliation later, not a pilot activation gate |
| Interviews | Consent, capture/review safeguards, saved progress/recovery, grading and private recordings | Actual audio versus answers, approved languages/devices, storage playback/download |
| Calendars and meetings | Offered-slot scheduling, Google/Outlook account flows, invitation/reschedule/cancel controls, managed Zoom and candidate join-link handling | Owned-account permissions and intended external effects; candidate must never see staff calendar contents |
| Human meeting notes / Recall | Reviewed source import, staff-controlled processing; managed-Zoom attendance preparation, approval, dispatch, recovery and cleanup controls | Consented real join, signed callbacks, usable audio, waiting-room behavior and provider-media cleanup |
| Zoho intake/interviews | Employer-bound connection, reviewed import/linking, campaign preparation, deliberate approved invitation, results review and controlled progress/approved-assessment publication | Dummy employer/application, permissions, independent work-order approval, actual invitation and approved publication |
| Zoho stages | Mapping, frozen local requests, approval/withdrawal/history, HTTP adapter and concurrency/source/erasure fences | **Live dispatch remains unfinished**: verified employer/application transition evidence and reviewed Blueprint/field/notification effects must precede execution wiring and a safe dummy write |
| Greenhouse | Direct employer connection/confirmation, reviewed intake/linking, individual and reviewed-batch interview controls, invitation outcome recovery, approved progress/assessment note publication | Real employer permissions, dummy-applicant end-to-end flow, note visibility and no duplicates |
| Offers | Employer-owned human approval, deliberate send, response handling and uncertain-attempt controls | Actual HR ownership/legal review and selected ATS handoff; no autonomous offer issuing |
| Candidate data | Registration/activation and visibility controls; private career/learning boundaries and erasure controls | Staff/candidate visibility and deployed-role checks using approved test identities |
| Email reliability | Reservations before contact for manual replies, reminders, inactivity, self-report/status check-ins and weekly digests; missed private weekly recap recovery; metadata-only platform-admin hold review; existing post-hire claim retained with single-attempt transport | Real receipt/events; review is not provider verification and cannot authorize resend |

Additional ATS adapters and full feature parity with Noon are **not** implied.
This handover does not reopen unapproved WhatsApp/LinkedIn automation, universal
ATS synchronization, autonomous offers or changes to stabilized AI configuration.

## 2. Email changes in this handover

- Status check-ins remain default-on under the existing
  `STATUS_CHECKIN_ENABLED` opt-out. The old “LinkedIn monitor disabled” description
  was incorrect for current startup. Optional profile lookup remains conditional;
  no provider/cron flag has been changed.
- Status check-ins and candidate self-reported changes share the existing
  follow-up cooldown and a durable reservation group, including uncertain attempts.
- Weekly digests retain their six-day minimum, existing privacy rules, templates
  and candidate notification. A separate receipt family respects the old timestamp
  but protects against duplicates when that timestamp update fails.
- Weekly digest receipts contain a generic summary, not learning/peer/badge
  content. They do not feed the job-change or inactivity reminder cooldown.
- Post-hire 30/90-day timestamps remain **claims**, not delivery evidence.
  One SDK attempt is requested. Simulation, suppression or ambiguity is not
  counted as acceptance, and a claim is never automatically cleared for retry.
- Accepted mail does not mean delivered/read. Do not resend an uncertain
  attempt merely because it lacks a final saved receipt.

No new migration or paid pilot restriction is introduced by these sender changes.

## 3. One ordered acceptance run

All workbook cases start **Not Run**. Assign named people before execution:
release owner, employer administrator, separate work-order approver, recruiter,
candidate tester, calendar/meeting host, ATS owner and security reviewer.

1. **Run setup:** record the exact source/build, development API/frontend origin,
   database region/target, allowed test inboxes and account owners. Do not record
   secrets, auth cookies, OTPs or signed URLs.
2. **Access smoke:** roles, sign-out, suspended users, cross-employer denial and
   candidate-only versus staff-only pages.
3. **One native journey:** approved synthetic job and consenting test profile;
   interest first, reviewed invitation, interview, evaluation sign-off, human
   hiring decision and separately approved test offer. Keep the same identities
   and evidence through all stages.
4. **Zoho journey:** approved dummy job/application; preview/import/link; approved
   interview plan and campaign; controlled invitation; interview completion;
   local review; separately approved progress/assessment note. Do not substitute
   stage simulation for a remote change.
5. **Greenhouse journey:** confirm the correct employer, import/link one dummy
   applicant, prepare/approve/deliberately send one interview, review results,
   approve exact progress/assessment note, verify visibility and replay behavior.
6. **Scheduling and recording:** offered slots only; correct organizer and
   attendees; create/reschedule/cancel; verified join link; consented private
   recording upload/play/download. Test Recall only with approved host/meeting.
7. **Negative and recovery cases:** stale approval, permission revocation,
   disconnect, duplicate action, unknown send/write, partial batch, dropped
   connection and erasure. Review receipts before repeating external effects.
8. **Release-owner review:** reconcile defects and Blocked cases. Production
   host/database, reviewed migrations, storage/SES callbacks, capacity and
   rollback remain the deployment team's responsibility.

Use **Blocked**, not Pass, for missing accounts, authorization or provider
evidence. Attach sanitized actual results and defect/retest references to the
workbook. Do not turn local source review into a completed human acceptance case.

## 4. Entry points and evidence

- Staff: `/login`, Work Orders, Approvals, the job's candidate workflow.
- ATS: `/settings/ats`; imported applicant controls in the job workflow.
- Meetings: job/candidate **Meeting Notes**; calendar/meeting settings for owners.
- Candidate: owned portal and the issued interview/booking/offer link.
- Workbook: Smoke → same-identity E2E → module/negative → approved live providers.
- Technical evidence: current closeout plus the linked per-module engineering
  documents. Historical counts remain dated and are not relabelled current.

## 5. Handover gate

Ready **for controlled IT acceptance** means the measured development checks
pass, documentation matches the measured source, cases remain unexecuted until
IT runs them, and open external/build boundaries are explicit.
It does **not** mean production-ready, legally certified or complete Noon parity.
