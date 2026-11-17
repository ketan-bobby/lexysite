# Lexy — remaining team acceptance

Updated November 14, 2026. This is the current ordered checklist for the reviewed
scope, not proof of deployment, live delivery, complete Noon parity or legal
compliance. The accompanying
[editable execution sheet](remaining-acceptance-2026-11-14.csv) starts with
**18 Not Run checks and two Blocked implementation items**.

## 1. What is already locally verified

Do not repeat development-only work merely to resolve an older pending paragraph:

- [Consolidated development verification](../qa/consolidated-development-acceptance-2026-11-14.md):
  the recorded functional checks passed; the original baseline retains its
  formatting failure, followed by a successful formatting-only rerun.
- [Scheduling and ATS hardening](../qa/independent-ats-checks-2026-11-14.md):
  focused local fixes and their explicit evidence boundaries.
- [Campaign process recovery](../qa/campaign-process-recovery-2026-11-14.md):
  seven focused tests passed, including two killed workers, separate-process
  recovery and duplicate protection. No real provider acceptance was exercised.
- [Greenhouse manual HR assistance](../engineering/greenhouse-employer-hr-handoff.md):
  approval/export-bound reference and local browser checks. This is not connected
  offer creation, approval or delivery.

These are dated development results. The complete baseline was not rerun after
the later HR-guide and campaign-process test increments. New changes must receive
checks appropriate to what they affect.

## 2. Setup and execution rules

The release owner records the exact frontend/API source revision and artifact
digests, test environment, database target, execution date and named owners.
An older ZIP or its source manifest does not identify later source changes.

Use one approved dummy employer/job/application and consenting internal testers.
Assign a separate work-order approver, employer administrator, recruiter,
candidate tester, calendar/meeting host, ATS owner, security reviewer and release
owner. Record an explicit allowlist of test recipients and authorization for
each external send or write. A connected account is not permission to dispatch.

Start in the agreed nonproduction acceptance environment. This checklist does
not authorize production migration, contact, load testing or deployment. Production
verification is a separate release-owner decision after acceptance.

Statuses:

- **Not Run:** no team evidence recorded for this delivered build.
- **Pass:** expected positive and negative outcomes were observed and linked.
- **Fail:** an observed outcome differed; record a defect and stop dependent work.
- **Blocked:** a prerequisite is absent; identify its owner and unblock condition.
- **Out of scope:** product/release owner explicitly excluded it, with rationale.
  This is not a pass or a claim that the capability is implemented.

Store private evidence in the team's approved location. The sheet should contain
references, not passwords, keys, OTPs, auth tokens, signed media links or candidate
transcripts. Redact unnecessary personal data from screenshots and logs.

## 3. Ordered acceptance checks

### ACC-01 — Confirm the delivered build and database prerequisites

**Owner:** release and database owners. **Priority:** P0.

Review the documented migration sequence against the actual target and applied
migration ledger; do not run every SQL file or substitute schema push. Confirm
authentication migrations **0113 → 0114 → 0115**, security policies and coordinated
API replacement requirements. Record backup/rollback responsibility and matching
frontend/API revisions. Verify the agreed environment's origins, OAuth callbacks,
cookie configuration and signed callback endpoints without recording secrets.

**Pass evidence:** build identifiers, target verification and migration/security
review. No subsequent environment-dependent case can pass against an unknown build.

### ACC-02 — Verify sessions across deployed replicas

**Owner:** security reviewer. **Priority:** P0. **Depends on:** ACC-01.

Use separate test sessions. Logout must revoke only the selected session; copied
credentials must fail through another API instance and after an approved instance
restart. Password reset/change and password-confirmed all-device logout must
invalidate prior sessions while an appropriate fresh session remains usable.
Confirm suspended users are denied. SSO-only users must not gain a
password-confirmation bypass.

**Pass evidence:** denied old credentials plus valid independent/fresh controls;
no credentials in the execution sheet. This is deployment acceptance of existing
local protections, not a request to weaken authentication.

### ACC-03 — Check tenant isolation and candidate visibility

**Owner:** security reviewer and employer admin. **Priority:** P0.

Use approved staff/candidate test identities from different employers. Verify
staff lists and by-ID reads enforce tenant, assignment and role restrictions.
Register a candidate through the intended candidate page and check staff visibility
under the intended consent/privacy rules; registration must not automatically
publish a private profile into an employer pool. Private coaching/learning data
must not become hiring evidence.

**Pass evidence:** authorized positive controls and cross-employer/role denials,
with expected registration and discovery behavior.

### ACC-04 — Complete one native hiring journey

**Owner:** recruiter, independent approver and candidate tester. **Priority:** P0.

Keep the same dummy work order, candidate and application throughout. Submit a
draft for independent approval; confirm unapproved work cannot send invitations.
Follow the intended interest/reply flow, reviewed invitation, interview, evaluation
review and explicit human decision. Reconcile the displayed scores and pipeline
outcome with the saved evidence. Do not silently substitute synthetic clearance
for identity or assessment evidence.

**Pass evidence:** attributable approval, stage and interview references with
the expected human checkpoints. Offer delivery is separately covered by ACC-18.

### ACC-05 — Verify sourcing and enrichment with authorized accounts

**Owner:** recruiter and provider owner. **Priority:** P1.

For an approved dummy requisition, verify internal search/review and an explicitly
authorized external search, enrichment and request attribution. Confirm real
results are distinguished from simulation, empty data and provider failures.
Avoid candidate contact. Preserve internal-first and privacy controls; invoice
reconciliation is later business work, not a new paid-activation gate.

**Pass evidence:** scoped provider/request references and honest result states.

### ACC-06 — Verify the scheduling candidate picker

**Owner:** recruiter/coordinator. **Priority:** P1.

At `/coordinator`, search by candidate and role, select the intended application,
and confirm canonical candidate names display. Exercise a failed list read and
reload; the draft must survive and options must recover. Only book the approved
dummy candidate after separately authorizing any resulting notification.

**Pass evidence:** displayed application identity and successful read recovery
without silent draft loss or a misleading empty list.

### ACC-07 — Verify Outlook sharing and restricted availability

**Owner:** Microsoft account owner and coordinator. **Priority:** P0.

At `/settings/calendar`, opt in, reload and withdraw panel availability using the
intended staff-owned Outlook account. Confirm only offered/common slots are
available to authorized coordinators. Check the candidate-facing view contains
neither whole calendars nor event titles, attendees or busy-event details.
If a save is uncertain, read current status before any deliberate retry.

**Pass evidence:** persisted choice, authorized slot behavior and privacy denials;
a project connection alone does not prove employer ownership or access.

### ACC-08 — Verify Google panels and booking-link privacy

**Owner:** Google account owners and coordinator. **Priority:** P0.

Confirm each staff-owned account and opt-in choice, then check a saved panel's
common offered slots. Exercise withdrawal/account changes and expired or altered
candidate booking links. Another candidate or employer must not gain access.
Candidates must see intended choices only, not staff calendar contents.

**Pass evidence:** owner binding, intended slots, safe withdrawal and invalid-link
denials.

### ACC-09 — Verify Google invitation, change and cancellation

**Owner:** calendar owner and candidate tester. **Priority:** P1.

After explicit staff approval, book the dummy appointment, verify the correct
invitation and candidate Meet link, then reschedule and cancel through the supported
controls. Confirm the remote event and candidate view agree. Repeated actions must
not create duplicate invitations; ambiguous provider outcomes require review.

**Pass evidence:** exact remote event identity and matching local/candidate state,
without exposing private calendar content.

### ACC-10 — Verify managed Zoom ownership and recovery

**Owner:** original Zoom host and coordinator. **Priority:** P1.

Using the intended host account, create, change and cancel an approved dummy
meeting. Verify join-link visibility and host ownership across client scopes.
Distinguish a manually pasted link from a managed meeting receipt. Review ambiguous
operations instead of automatically creating a replacement meeting.

**Pass evidence:** host-bound provider references and matching operation outcomes.

### ACC-11 — Check interview voice, adaptation and resume

**Owner:** candidate testers and fluent language reviewers. **Priority:** P0.

Complete an approved test interview using offered devices and languages. Compare
actual speech with saved answers, including a long answer, a stated skill gap and
refresh/resume. Confirm introduction, turn-taking and conditional weak-capture
review behavior. Do not expect answer confirmation after every question.
Verify saved progress, final evaluation and human review.

**Pass evidence:** private audio/transcript comparison and per-language/device
results. Do not change stabilized models, prompts or routing to obtain a pass.

### ACC-12 — Check recording import, retention and download

**Owner:** recording/storage owner and security reviewer. **Priority:** P0.

Use a consented dummy recording. Verify import/capture, audible candidate speech
through the recording tail, interrupted upload recovery, playback and authorized
download. The download action must save a playable file, not merely open a new
tab. Check unauthorized reads and the agreed retention/deletion behavior.

**Pass evidence:** private media inspection, download and access-control results;
a stored pointer is not proof that useful audio was captured.

### ACC-13 — Verify consented Recall attendance and signed callbacks

**Owner:** original meeting host and Recall owner. **Priority:** P1.

Confirm the configured regional workspace, employer authorization and separate
host approval before dispatch. Use a consented supported dummy Zoom meeting and
the visible assistant. Check waiting-room admission, actual join/stop, signed
callbacks to `/api/meeting-assistant/recall-events`, import and provider cleanup.
Unsigned or invalid callbacks must be rejected.

**Pass evidence:** attributable provider lifecycle and signed delivery references,
usable media and cleanup outcome. The reported secret/callback setup is not yet
evidence of a completed live meeting. Imported notes are not automatically an
approved assessment.

### ACC-14 — Verify Zoho reviewed import

**Owner:** employer Zoho admin and recruiter. **Priority:** P1.

Confirm the exact employer/account and dummy job/application association in
`/settings/ats`. Preview and deliberately import/link only the approved dummy
records. Repeat the selection and confirm no duplicates or cross-account links.
Connection and import must not send invitations on their own.

**Pass evidence:** exact remote/local record references, employer binding and
idempotent import.

### ACC-15 — Verify the approved Zoho interview campaign

**Owner:** employer admin, independent approver and candidate tester.
**Priority:** P1. **Depends on:** ACC-14 and work-order approval.

Prepare and review the selected dummy applicant campaign and interview plan.
Authorize the controlled recipient, approve dispatch deliberately, receive one
invitation and complete the interview. Check saved delivery evidence, evaluation
and current human review. Test retry/reload without sending again. An uncertain
attempt must remain held, not be treated as delivered or automatically resent.

**Pass evidence:** campaign/application/session identity continuity and receipt
states. Local crash tests already passed; do not kill live workers as part of
this manual case.

### ACC-16 — Verify Zoho progress and approved-assessment publication

**Owner:** employer Zoho admin and authorized assessment reviewer.
**Priority:** P1. **Depends on:** ACC-15.

Preview the intended progress note and separately approve assessment disclosure
for the exact dummy application. Publish only the approved content with required
permissions, read it back in Zoho and verify no duplicate on replay. Unapproved
assessment content and private development data must not be published.

**Pass evidence:** human approval, matching remote note and local attempt reference.
A note receipt is not an application-stage change or an offer.

### ACC-17 — Verify Greenhouse overlay and manual HR handoff

**Owner:** employer Greenhouse admin, assessment reviewer and HR. **Priority:** P1.

With an authorized employer account, verify dummy-applicant read/import/link,
reviewed interview invitation and approved progress/assessment note publication.
Then review the approved/exported manual HR packet: reference IDs and snapshot
must match; stale or unauthorized content must hide. HR verifies the application
and completes financial terms, approval and any separate human send in Greenhouse.

**Pass evidence:** matching employer/application, controlled interview/note receipts
and an accurately labelled manual handoff. A copied reference or locally reported
handoff must not be recorded as an API-created, approved or delivered offer.
The connected-offer build gap below is not passed by this case.

### ACC-18 — Verify mail reliability and human-only offers

**Owner:** mail/cloud owner, security reviewer and HR. **Priority:** P0.

Verify the approved test inbox receives the intended invitation and configured
SES events reach the correct environment. Reconcile provider acceptance with
delivery/bounce/complaint events; inspect Mail Holds with platform-admin access.
Review metadata must not authorize resend. For a separately authorized native
test offer, verify HR ownership, exact-version approval and a distinct deliberate
send; edits must invalidate old approval. Confirm a candidate response without
treating acceptance as employment, identity proof or a fee trigger.

**Pass evidence:** safe email-event handling, restricted hold review and human
offer controls. A real offer or candidate must not be substituted for test data.

## 4. Implementation and connected-acceptance gaps

### BUILD-01 — Zoho remote stage execution

**Owner:** integration engineering and employer Zoho admin.
**Status:** Development execution source/routes/UI implemented; runtime activation
off, genuine employer evidence and live acceptance outstanding.

The [internal execution assembly](../engineering/zoho-stage-execution-assembly.md)
connects proof-bound preparation, approval, SQL claims, transport and read-only
recovery. A concrete OAuth custody/connected transport adapter is now implemented;
its checks use synthetic credentials and HTTP responses, including composition
with the private rollback-only SQL ledger. The
[controlled execution workflow](../engineering/zoho-controlled-stage-execution.md)
now binds the connected source, transport and ledger to separate explicit
prepare/approve/execute controls. Activation defaults off; no live write was
performed. The [employer evidence review workflow](../engineering/zoho-employer-transition-evidence.md)
now supplies authenticated proposal intake, independent verification, revocation,
an immutable journal and a same-transaction server-only proof loader. It requires
real employer-specific contract/isolation/Blueprint/field/side-effect references;
synthetic checks do not establish those facts. Establish genuine evidence and
independent employer review, then perform a
separately authorized dummy-only write/read-back. Stage catalogue or history
metadata is insufficient.
Until then, do not advertise automatic Zoho application advancement.

Cross-staff execution identity/revision behavior is now covered locally:
separate preparer, approver and executor identities remain attributable without
relabeling the frozen preparer. Fresh and locked source snapshots must identify
the current caller. Older actor-bound approvals are not silently upgraded;
unresolved older attempts continue to block new claims and allow read-only observation.

### BUILD-02 — Connected Greenhouse financial offers

**Owner:** integration engineering, employer Greenhouse admin and HR.
**Status:** Blocked.

The [controlled assembly](../engineering/greenhouse-offer-assembly.md) now connects
the local HR workspace, configuration/evidence validation, durable claim,
single-attempt draft creation, committed draft receipt, separate employer
approval request and independent read-back. Its browser confirmation explicitly
acknowledges employer approver emails. No candidate-delivery action exists.

Passed locally: **106** transport/configuration/assembly/field tests,
**24** policy/journal tests, **17** workflow regressions, **9** crash-recovery tests
and **25** browser checks, plus API/web type checking. A killed process or
PostgreSQL restart cannot turn a committed draft hold into permission to resend.

**Not activated:** the default application still has no authoritative custody,
independent employer-review or workflow-evidence bindings for this transport.
Integration engineering must supply those real server loaders, verify undisclosed
employer rules/permissions, explicitly mount the configured workspace and complete
authorized employer/deployment acceptance. This is not just entering a key or
checking a client-side box. A connected provider factory exists; live source
bindings and real acceptance do not.

The development API port-ownership conflict was subsequently resolved: the older
verified development listener exited gracefully, and the managed workflow rebuilt
and started the current source with one listener. Liveness and database readiness
returned HTTP 200. Normal startup sent the existing billing-warning admin email;
billing safeguards, schedulers, secrets and production configuration were unchanged.
The earlier isolated financial checks made no live ATS requests or email sends;
the later runtime restart generated the existing admin alert described above.
No production or secret configuration was changed.
Greenhouse create-offer may affect an existing chain; the generic financial-write
ban remains intact.
See the [HR handoff boundary](../engineering/greenhouse-employer-hr-handoff.md).

Either gap may be explicitly excluded from a narrower pilot by the product and
release owners. Record the exclusion; do not relabel it as implemented or passed.

## 5. Exit criteria and ownership

1. Record results, evidence and defects in the CSV for the exact delivered build.
2. Stop dependent tests on P0 failures, wrong-employer data, calendar disclosure,
   unapproved sends, missing human approvals or duplicate contact. Preserve the
   uncertain attempt; do not clear claims simply to make a retest possible.
3. Recheck affected cases after fixes. Changes to source, migrations or deployed
   configuration invalidate affected evidence, not automatically every prior test.
4. Record the owner and resolution/exclusion for every blocked item.
5. Obtain release, security, employer and HR sign-off for the selected pilot scope.
   Passing local tests or completing this checklist is not production approval.

**No release decision has been made in this document.** Production capacity,
legal certification, extra ATS adapters and full Noon parity remain outside the
evidence recorded here. Invoice reconciliation remains deferred; it does not
reintroduce paid activation for the complimentary internal pilot.
