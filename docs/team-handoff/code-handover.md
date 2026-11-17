# Lexy code handover — current scope

**Development billing alerts and interrupted Zoho responses:** development
restarts now retain the billing sentinel's log/in-app warnings without emailing
real staff. Production email policy is preserved for `NODE_ENV=production`;
checkout, complimentary access and billing settings are unchanged. The
[isolation guide](../engineering/development-billing-alerts.md) describes the
policy and 11 passing isolated tests. Added 18 passing intercepted browser cases
for saved Zoho proposals/approvals/rejections followed by network, 409 or 422
response failures across desktop and 390px. These cases confirm refreshed saved
history, no stale confirmations and no automatic repeat. The campaign fixture
now contains 80 cases; the 18 new cases were run as a focused set, not claimed as
a new full-suite pass.

**Independent Zoho uncertainty closure:** the
[proposal, review and acceptance guide](../engineering/zoho-stage-uncertainty-resolution.md)
documents the new employer-admin control. A different active administrator must
review a time-limited proposal against a fresh read-only observation. Approval
closes only the local operational hold, preserves unknown delivery and prevents
old commands, approvals or evidence from enabling a later write. Rejection keeps
the hold. Late receipts cannot reopen an approved closure. The journal needs no
new database migration. The focused backend fixture passed **35/35** checks;
the expanded isolated restart suite passed **18/18**, and the campaign browser
fixtures passed **62/62** across desktop and 390px. These are local/simulated
checks; live employer acceptance remains separate.

**Earlier Zoho restart regression and offer test startup:** the
[isolated connected-assembly restart suite](../engineering/zoho-stage-restart-testing.md)
passed **17/17 test results** (16 scenarios plus the parent), including nine new
HTTP-assembly crash/recovery and authority scenarios. The separate local
controlled-offer browser suite now passes **36/36** after fixture module warmup
and a bounded navigation allowance; interaction timeouts and safety assertions
were not relaxed. These are fixture checks, not live employer acceptance.
Zoho execution remains off by default. Read-only observations themselves still
retain the hold; the separately reviewed closure control is described above.
No production setting or LLM configuration was changed.

**Greenhouse controlled financial assembly:** the
[assembly and acceptance guide](../engineering/greenhouse-offer-assembly.md)
now connects the durable draft receipt, separate internal-approval request,
exact read-back and explicit HR workspace confirmation. Local checks passed:
106 transport/configuration/assembly/field tests, 24 policy/journal tests,
17 workflow regressions, 9 crash-recovery tests and 25 browser checks, plus
API/web type checking. No production, real ATS, email or LLM changes were made.
**BUILD-02 remains Blocked:** authoritative custody/review/evidence loaders,
explicit deployment bootstrap and employer sandbox acceptance are still required.
Keys alone do not activate this path. The development API port conflict was
subsequently resolved with graceful shutdown and a fresh managed build; liveness
and database readiness both returned HTTP 200. Normal startup emitted the existing
billing-warning admin email; billing safeguards and production were unchanged.

**Greenhouse employer configuration:** the
[read-only configuration reader](../engineering/greenhouse-offer-configuration.md)
now covers offer definitions, choices, inherited visibility, openings/reservations
and approval metadata. Two matching bounded sweeps detect drift. The combined
suite originally passed 75 tests. Missing system/currency rules remain unknown.
The reader now feeds the opt-in controlled assembly above; authoritative
custody and independently verified employer rules are still required.

**Greenhouse permission/approval reads:** the
[local evidence evaluator and approval reader](../engineering/greenhouse-offer-evidence.md)
now bind fresh employer/caller/credential evidence and distinguish job approval
from candidate-offer approval. The expanded transport suite passed 51 tests.
Actual permission discovery, custody resolution and authorized live acceptance
remain. The version-fenced provider assembly is now implemented locally; no live
actions were enabled.

**Greenhouse wire transport:** a
[bounded local HTTP/financial encoder](../engineering/greenhouse-offer-http.md)
now supports scoped reads and draft-creation encoding with no automatic retries.
It is now assembled behind explicit server dependencies, not activated in the
default app. Real employer/custody inputs and authorized acceptance remain;
default live financial actions are unavailable.

**Greenhouse ledger durability:** the
[isolated crash/concurrency regression](../engineering/greenhouse-offer-durability.md)
passed nine tests using independent workers, real commits and a disposable
PostgreSQL crash/restart. Uncertain attempts never resubmitted. This closes the
local ledger durability gap, not live Greenhouse or production acceptance.

**Greenhouse employer workspace:** see
[the local proposal/review implementation](../engineering/greenhouse-offer-workspace.md).
Authenticated HR reads, persistent proposals/history, stale-edit protection and
separate review/submission controls are now connected to the workflow. Live
provider operations remain unavailable; only injected simulations are exercised.

**Greenhouse local control increment:** see
[the financial-offer control boundary](../engineering/greenhouse-offer-controls.md).
Human/version-bound intent, field validation, SQL claims and read-only recovery
are implemented internally with simulated provider responses. No connected offer
route, screen or live transport was added. BUILD-02 remains Blocked.

**Zoho internal execution increment:** see
[the execution assembly boundary](../engineering/zoho-stage-execution-assembly.md).
Proof-bound preparation, approval, SQL-ledger execution and read-only recovery
have fixture coverage. A concrete employer OAuth custody/connected transport
adapter is implemented and tested with synthetic credentials and HTTP responses,
including composition with the private SQL ledger. The earlier local-only route
remains non-executing. The [employer evidence review workflow](../engineering/zoho-employer-transition-evidence.md)
now provides intake, independent review, immutable storage and a guarded proof loader.
Cross-staff identity/revision handling now has isolated SQL regression coverage,
including distinct preparer/approver/executor attribution and legacy unresolved
attempt holds. The [controlled-execution integration](../engineering/zoho-controlled-stage-execution.md)
now adds the connected source and separate explicit execution routes/UI, with
activation off by default. Actual employer-specific evidence and live acceptance
remain outstanding.

**Current team run:** use
[the remaining acceptance checklist](remaining-acceptance-2026-11-14.md)
and [editable results sheet](remaining-acceptance-2026-11-14.csv). They distinguish
live acceptance from unfinished Zoho stage execution and connected Greenhouse
financial offers. No manual case is marked passed by local fixture results.

**Campaign restart verification:** see
[the process-recovery addendum](../qa/campaign-process-recovery-2026-11-14.md).
The isolated campaign regression now kills real worker processes and verifies
recovery and duplicate protection from separate processes. It does not establish
production capacity or real provider delivery.

**Greenhouse manual HR increment:** see
[the employer HR handoff guide](../engineering/greenhouse-employer-hr-handoff.md).
Approved/exported packets now include a minimal copyable reference and
provider-specific HR instructions. This does **not** complete connected
Greenhouse offer creation, approval or delivery.

**Latest development verification:** see
[the November 14 consolidated acceptance report](../qa/consolidated-development-acceptance-2026-11-14.md)
and [the focused hardening addendum](../qa/independent-ats-checks-2026-11-14.md).
Use their explicit run status; an unfinished run is not a passing gate.
The historical snapshot and results below remain dated evidence.

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
| Zoho stages | Mapping, separate local/execution-purpose requests, employer evidence and independent review, connected source, explicit prepare/approve/execute controls, durable claims, read-only recovery and cross-staff attribution | **Activation remains off**: genuine employer/application evidence, separately authorized safe dummy write/read-back and team/deployment acceptance remain required |
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

The [current checklist](remaining-acceptance-2026-11-14.md) supersedes this earlier
summary for execution order, per-case outcomes and remaining implementation gaps.
Use its CSV to record current-build evidence; the older workbook remains dated.

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
