# Lexy — System Documentation and IT Handoff

**As-built snapshot: updated November 10, 2026**

Start with **Lexy-Code-Handover.pdf** in the download pack for the current
implemented/built-versus-live-acceptance matrix and ordered team run. Current
final verification is recorded in `docs/qa/code-handover-closeout-2026-11-10.md`.
Earlier dated regression numbers below are historical, not blanket sign-off
for later changes.

November 10 closeout: the combined run exposed one pre-transport validation bug.
It was fixed and the affected 27-test workflow group passed on rerun, with 43
additional mail checks and 34 runner/planner checks passing. The wider run
passed 283 frontend checks, ten browser groups, schema/type/build guards, lint
and formatting. The original 58/60 report is retained rather than relabelled
60/60; this is combined-plus-targeted-correction evidence.

Internal engineering and acceptance reference for LINX and the IT testing team.
The default target is development. Production is externally hosted and has not
been inspected, changed, migrated or certified by this documentation exercise.

## Contents

1. Executive status and how to use this pack
2. Product scope and implementation status
3. Architecture and technical inventory
4. Roles, tenancy and authorization
5. Test environment and account preparation
6. Native hiring workflow and autonomy
7. Work orders, ICP and approval
8. Candidate intake, registration and talent pools
9. Sourcing, enrichment and matching
10. Outreach, replies and candidate engagement
11. AI interviews and recovery
12. Scoring, review, identity and decisions
13. Scheduling, calendars and meeting links
14. Human interview recordings and notes
15. Optional Recall meeting attendance
16. ATS overlay: Zoho Recruit and Greenhouse
17. Controlled offers and employer ownership
18. Candidate portal, development and learning
19. Analytics, notifications and operational visibility
20. Complimentary testing, tiers and usage economics
21. Privacy, security, fairness and erasure
22. Configuration and provider setup
23. Database changes and release operations
24. Verification evidence and its limits
25. Remaining gaps and the Noon comparison
26. IT test execution, defect reporting and sign-off
27. Troubleshooting and recovery
28. Source reference index and technical appendices

## 1. Executive status and how to use this pack

Lexy is an AI-assisted hiring platform with its own native recruiting workflow
and an overlay approach for employer-owned ATS systems. It covers work orders,
candidate intake and sourcing, engagement, AI interviews, evidence review,
scheduling, human interview evidence and controlled employer-owned offer handoff.
The candidate experience also includes private career development, practice and
learning.

**Do not confuse implementation, automated evidence and live acceptance.**

| Label | Meaning |
| --- | --- |
| Implemented | A code path and relevant application surface exist; setup and acceptance may still be required. |
| Development verified | A dated automated, mocked, browser-fixture or isolated database check passed. It proves only the tested conditions. |
| Live acceptance pending | An authorized real provider/account or human tester must complete the flow. |
| Setup pending | Credentials, callback, consent, account permissions, target selection or configuration must be supplied or confirmed. |
| Build gap | Functionality is not completed; configuration alone will not finish it. |
| Not assessed | No claim is made for this feature or external environment. |

The workbook starts every manual test at **Not Run**. Recorded historical
regressions are in a separate Evidence sheet; they do not pre-fill human test
results. A passing development test is not permission to contact candidates,
join meetings, send offers or change an ATS.

### Current evidence correction

The latest combined development regression completed November 8 at 03:40:42 UTC
and passed **60/60 required check groups**: 1,290 API tests in 134 files,
283 frontend logic tests, ten intercepted browser groups and the schema,
type/build/security/lint/format checks. This supersedes the previously open
combined-gate failures. It is not manual acceptance or live provider evidence.
See `docs/qa/independent-development-closeout-2026-11-08.md`.

## 2. Product scope and implementation status

| Area | As-built scope | Acceptance boundary |
| --- | --- | --- |
| Native recruiting | Work orders, approvals, configurable journeys, candidate stages, evidence and human decisions | LINX end-to-end human acceptance remains required. |
| Autonomous options | Requisition configuration, shadow proposals, controlled execution, queues, pause/recovery and human checkpoints | Autonomy is not universal permission or a promise of unattended hiring. |
| Candidate intake | Recruiter intake/import, public career registration, candidate account/profile and consent-aware discovery | Verify admin visibility separately from eligibility for the shared pool. |
| Sourcing/matching | Internal discovery, provider adapters, enrichment, job-specific fit and accumulated intelligence | Test genuine provider responses with authorized dummy data; do not invent coverage. |
| Engagement | Draft/review/send, reply/interest handling, inbox and follow-up controls | Verify delivery and ordering with a controlled inbox; uncertain sends must not be blindly repeated. |
| AI interviews | Interview plans, invitations, identity/code entry, voice capture, resume/recovery, grading and recordings | Real microphone, language and browser acceptance is still necessary. |
| Calendars/meetings | Outlook and Google scheduling paths; managed Zoom; candidate-facing offered-slot and verified-link surfaces | Owned-account create/reschedule/cancel and privacy acceptance are required. |
| Human interview evidence | Manual upload, browser capture, native recording imports, processing and staff review | A recording/transcript is not an approved assessment or proven speaker identity. |
| Recall attendance | Optional visible, silent Zoom assistant with consent/approval, stop, receipt recovery and private import | Webhook secret/callback setup reported complete by the owner; signed-event receipt and a consented live dummy meeting still require acceptance. |
| Zoho Recruit | Direct employer-bound connection, reviewed imports, applicant campaigns, review and controlled note publication | Live campaign and note publication need account permissions and explicit consent. Remote stage advancement is a build gap. |
| Greenhouse | Employer-bound direct connection, reviewed intake, individual/batch interview preparation and deliberate sending, approved progress/assessment notes and outcome recovery | Real-account acceptance remains open; not universal two-way synchronization or live offer execution. |
| Offers | Employer-owned, human-approved/version-bound controlled offer preparation and delivery/response lifecycle | No autonomous final offer issuance or negotiation authority. |
| Candidate development | Career experience, private prep/practice, learning courses, assessment/reassessment, voice progress and rewards | Keep private development out of employer scoring unless separately allowed by the product boundary. |
| Governance/operations | Audit, human review, privacy controls, fairness checks, error telemetry, usage observations and release guards | Legal certification, production readiness, capacity and bill reconciliation remain separate. |

## 3. Architecture and technical inventory

### 3.1 Workspace structure

The application is a pnpm/TypeScript monorepo:

| Location | Responsibility |
| --- | --- |
| `artifacts/lexy` | Main React/Vite hiring and candidate web application. |
| `artifacts/api-server` | Express/TypeScript API, authorization, provider adapters, queues, background operations and media processing. |
| `artifacts/lexy-site` | Public marketing website, including the candidate acquisition entry point. |
| `lib/api-spec/openapi.yaml` | API contract and operation definitions. |
| `lib/api-client-react` | Generated web API client/hooks. |
| `lib/api-zod` | Generated API types/validation artifacts. |
| `lib/db/src/schema` | Drizzle schema definitions. |
| `lib/db/drizzle` | Ordered SQL changes, including security-sensitive database behavior. |
| `docs/engineering` and `docs/qa` | Engineering design and dated development evidence. |

The sales/candidate brochures and component-preview artifact are collateral,
not required steps in the hiring transaction.

### 3.2 Request and execution flow

Browser → same-origin artifact-aware API URL → caller/session resolution →
role, employer, requisition and candidate scope checks → business approval and
consent checks → database/provider/storage operation → durable result/receipt →
UI refresh or explicit uncertainty/recovery state.

Long-running work uses persisted queue/run/evidence concepts and leader-owned
background processes. Restart/retry behavior must reconcile existing work, not
silently create a new external action. Provider configuration remains distinct
from permission to execute.

### 3.3 Data and storage

PostgreSQL/Drizzle stores users, employer hierarchy, work orders, candidates,
applications, recruiting evidence, runs, scheduling, offer/ATS state, learning,
audit and usage observations. Some data has database row-level controls; other
service-admin reads require explicit application predicates as well. A parent
permission does not automatically authorize every child row.

Recordings, résumés and other files use the existing private storage paths.
Authorized download links and private object controls are part of the security
boundary. Do not make objects public to solve a failed download.

### 3.4 Technical appendices

The ZIP includes current generated **UI route**, **OpenAPI operation** and
**database table-name** inventories. These are implementation reference lists,
not proof of live coverage. Parameterized routes use placeholders. OpenAPI may
not describe every dynamic runtime route; inspect its linked route module when
debugging an operation. No database contents or secret values are exported.

## 4. Roles, tenancy and authorization

| Role/persona | Intended use and constraints |
| --- | --- |
| Platform administrator | Platform operations, candidate registration visibility, employer setup and privileged connection allocation. This is not automatic employer approval for every action. |
| Tenant administrator | Administration within the authorized employer/subtree; employer-level approval/ownership controls still apply. |
| Recruiter administrator | Recruiting-team administration, eligible approvals and authorized assigned/managed scope. Not unrestricted platform access. |
| Recruiter | Assigned requisitions and eligible candidate/application actions. Employer membership alone does not remove the assignment ceiling. |
| Hiring manager | Assigned requisition review and eligible human decision/interview actions. Not a general candidate database reader. |
| Interviewer | Narrow assigned interview/calendar tasks where supported. Not a recruiter or admin equivalent. |
| Candidate | Own portal/profile/application/practice/development and eligible interview/booking actions. Not employer-only results or private staff calendars. |
| Public token holder | Only the exact interview, booking, controlled offer or review package authorized by that token and its current validity. |

Employer HR responsibility is represented by the controlled employer owner/reviewer
workflow; do not assume there is a universal standalone `hr` login role or allow
an agency recruiter to impersonate employer HR.

Test both the UI and direct API access. Hidden buttons are not authorization.
Foreign IDs should not expose records. A lost/suspended session must not preserve
actionable private cached content. Tenant subtree scope, requisition assignment,
candidate ownership and provider host/account ownership are separate checks.

## 5. Test environment and account preparation

Use the known development application URL from the handoff message or current
workspace preview. The externally hosted production API URL is not established
by this pack. Development and production action links are not interchangeable.

Create an isolated, clearly labelled test employer/work order and consenting
dummy applicants. Do not repurpose old LINX jobs or real candidate data without
the data owner's approval. Existing imported dummy records may be used after
the team confirms their identity and current state in the UI.

Required personas:

1. Platform admin and employer admin.
2. Work-order author and a **different eligible approving reviewer**.
3. Assigned recruiter and a second recruiter without that assignment.
4. Assigned hiring manager/interviewer and a foreign-employer staff account.
5. Two candidate accounts with separate browsers/profiles.
6. Original meeting host with calendar/Zoom permissions and an unrelated host.
7. Employer-authorized offer owner/reviewer.

Use controlled inboxes and provider sandboxes/test accounts where available.
Record consent before contact or recording. Fill Run Setup before tests: build
reference, date/timezone, app/API environment, dummy record labels, approvers,
provider permissions and cleanup owner. Do not record credentials or token URLs
in a broadly shared workbook.

## 6. Native hiring workflow and autonomy

### 6.1 The actual six-stage evidence model

The standard single-interview journey is:

1. **Screening evidence**.
2. **Verification evidence**.
3. **Engagement evidence**.
4. **Interview evidence**.
5. **Human evaluation review**.
6. **Human hiring decision**.

Sourcing supplies the pipeline upstream. Scheduling supports the interview
stage. Offers are controlled downstream actions after an authorized human
decision; they are not an autonomous substitute for that decision.

The code supports AI, human, recruiter-choice, AI-then-human and human-then-AI
paths. A two-interview path has more than six individual evidence steps.
The phrase “six stages” is not a promise to skip one of those configured steps.

### 6.2 Autonomous versus assisted operation

Configuration, approved journeys, shadow proposals, controlled execution and
recovery are different capabilities. Merely saving a configuration must not
send an email, call a paid provider, create a meeting or publish an assessment.
Shadow mode must not be reported as executed work.

Human checkpoints remain important for job approval, controlled contact,
identity corroboration, evaluation, hiring decisions, employer offer authority
and external publication. Pause/stop blocks pending or new operations but cannot
recall already-delivered email or undo a completed provider action.

### 6.3 Acceptance

Carry the **same** job/application/candidate through the whole journey. Six
separate passing fixtures do not prove one continuous live workflow. Preserve
the attributable human review, current evidence revision and provider receipt
at each relevant step. Refreshes and retries must not duplicate operations.

## 7. Work orders, ICP and approval

Work orders hold role requirements, employer/client context, assignment,
recruiting configuration and interview/approval context. The client’s external
requisition number is distinct from Lexy’s internal work-order number.
Multi-recruiter staffing does not require duplicate work orders.

Draft creation is not approval. A draft must be **submitted for review** before
it appears as a pending approval. The UI exposes submission on the work-order
detail page and explains this boundary. A qualifying different reviewer makes
the approval; the author should not self-approve.

ICP generation/editing governs sourcing requirements. Test nullable location
and deliberate “no preference” behavior rather than letting an old job location
silently reappear. Saved assignments, requirements and interview plans must
remain job-specific.

Unapproved work orders must not start candidate interview actions, even if an
old invitation/session already exists. New-plan generation rejects empty or
malformed plans and receives authorized job context as untrusted reference data;
this does not authorize arbitrary changes to stabilized AI configuration.

## 8. Candidate intake, registration and talent pools

Candidate entry includes recruiter-created/imported profiles, sourced profiles,
job applications and self-registration from the candidate/career experience.
Public acquisition, authentication account, career profile, job application and
shared discovery eligibility are related but distinct records.

**Where to inspect new registrations:** platform administrators can use
`/platform/candidate-registrations`. Candidate lists and shared platform-pool
views serve different purposes. A registration saved in the database must not
be assumed to be discoverable by every employer.

Employer-owned candidate pools remain scoped. Shared platform discoverability
depends on candidate consent and privacy settings. Discovery opt-in/revocation,
DNC/erasure exclusions and employee/internal-mobility treatment need separate
acceptance. Candidate email deduplication/merge should not create silent duplicate
people or leak records across employers.

Candidate self-service development material and employer-facing assessment
material are not interchangeable. A portal account can exist while its private
development evidence is correctly invisible to recruiter scoring.

## 9. Sourcing, enrichment and matching

The sourcing provider adapter layer supports internal-first discovery and
configured external discovery/enrichment paths such as PDL, SERP-based search
and Enrich Layer. Test the actual adapter and active account, not just the
presence of an API key.

Internal discovery and external calls are separate. An internal-review checkpoint
is a workflow control, not a subscription paywall. Complimentary internal
testing must not be held behind invented paid activation.

Verify job/ICP context, meaningful location/language handling, candidate admission,
email normalization, deduplication, provenance and genuine empty/error results.
Remote roles and deliberate location relaxation must not become false hard-city
exclusions. Provider success does not prove contactability, candidate consent or
complete profile accuracy.

Matching combines job-related evidence and accumulated candidate/job intelligence.
Displayed null scores must remain “—”, not invented zero/50. Trust gates, score
bands and stale-profile ranking must be consistent across profile, list and
decision surfaces. Stored evidence should not be overwritten by random fallback
scores or private career-development signals.

## 10. Outreach, replies and candidate engagement

Outreach includes drafting, editing before approval, controlled dispatch,
interest/reply tracking, inboxes and follow-ups. Lexy branding and employer
attribution both matter. The actual sender/account, candidate address and
environment-owned action links must be correct.

For sourcing outreach, verify the intended sequence: interest-check contact,
recorded candidate response, required staff review and then an interview invite.
Do not send an interview first and a contradictory “are you interested?” later.
An ATS **applicant campaign** has a different admission context; do not invent
a mandatory sourcing-interest email where that configured path does not require it.

The first-touch dispatcher and approval controls should prevent duplicate sends.
If a provider may have accepted a send but the receipt is uncertain, hold and
reconcile instead of automatic resend. “Queued”/“accepted by provider” is not
proof of inbox delivery.

Reply synchronization, recruiter notifications and inbox pagination must remain
recipient/tenant scoped. Quiet settings, withdrawal, DNC, rejection and erasure
must have their documented effects. Mark spam/delivery problems as defects with
safe provider receipt references, not with copied secrets.

## 11. AI interviews and recovery

The interview flow includes a job-bound plan, invitation/link, required access
verification and consent, device/microphone checks, spoken prompts, answer
capture, save/resume, completion and downstream grading.

Test introduction and resume greeting separately: a resumed session should not
misrepresent itself as a brand-new interview or discard saved progress. The
24-hour completion message does not mean every refresh starts a new session.

Capture acceptance must compare **spoken source audio, saved answer and resulting
question**, especially for short/weak audio, long answers, interim speech,
background noise and speaker echo. Lexy must not answer its own questions or
submit its own synthesized speech as candidate evidence.

Targeted adaptation was approved for explicit skill gaps and ambiguity.
For example, “I do not know TypeScript” must not produce fabricated TypeScript
experience or continued unsupported assumptions. Verify against the audio;
a second transcription alone is not definitive proof of what was said.

The captured-answer review screen is **conditional**, not an “are you satisfied?”
question after every answer. Where weak/ambiguous capture triggers review, its
message and confirm/re-record controls must be clearly visible, including on
small screens and with camera enabled.

The existing configured models, voice/STT routing, prompts and rubrics are
stabilized. This testing pack does not change them. Exercise the languages
currently offered in the application and record the resolved route/receipt;
do not infer a provider merely from the language name or switch models to pass.

Test Desktop Chrome/Edge, a supported mobile browser, denied devices, refresh,
temporary network loss, repeated completion and late/stale writes. An employer
interview’s confidential results must not appear as a candidate’s private
practice/baseline result.

## 12. Scoring, review, identity and decisions

Completed interview evidence feeds the existing evaluation/intelligence flow.
Completion, grading, persisted summary, score refresh, queue work and human
review are separate outcomes that each need verification.

Job interview answers and rubrics remain distinct from private career/practice
development. Display real zero where evidence supports zero, and missing values
as missing. A polished answer format alone must not replace substantive evidence.

Identity verification uses the approved human-review approach where appropriate.
AI advice, a manual note and a workflow-only synthetic clearance are not the
same as independently corroborated identity. Do not label a synthetic fixture
“identity verified” for real-world purposes.

Human evaluation review and hiring decisions are attributable and evidence-bound.
Correction should preserve history and prevent stale prior reviews from controlling
new evidence. A positive AI recommendation is not an offer authorization.
Proctoring signals are risk indicators with source-consistent thresholds, not
automatic proof of misconduct or a legal adverse action.

## 13. Scheduling, calendars and meeting links

| Integration/surface | Implemented boundary to test |
| --- | --- |
| Outlook/Microsoft calendar | Staff consent, availability/scheduling operations and controlled candidate/panel invitation flows. Email consent alone does not prove calendar permission. |
| Google Calendar | Staff account binding, private availability/panels, approved invitations, meeting operations and candidate-facing confirmed links. A project connection is not employer/host authorization. |
| Google Meet | Verified meeting link and native recording-import paths tied to the owned account and managed appointment. |
| Zoom | Staff account/link ownership, managed meeting lifecycle, recovery and native recording import; original host and current appointment context matter. |
| Candidate booking | Token/identity-scoped offered slots, current availability/expiry, confirmation and request/withdrawal flows. |

Candidates must see **only staff-approved offered slots**, never full recruiter
or hiring-manager calendars, unrelated meetings, attendee lists, subjects or
busy-event details. Test this through network responses as well as the visible UI.

Reschedule/cancel must keep local status, provider receipts, candidate links and
notifications consistent. A proposed time-change request is not a confirmed
reschedule; withdrawal is not cancellation of an existing appointment.
Concurrent booking and stale slot/link attempts need explicit outcomes.

Do not treat a manually pasted Zoom/Teams URL as a managed provider meeting.
Native Microsoft Teams meeting lifecycle, Gmail, Calendly and additional tools
are not certified by the calendar paths described here.

## 14. Human interview recordings and notes

Existing staff evidence paths include manual media upload, browser capture and
reviewed native Zoom/Google Meet recording import. They save private meeting
notes with source context and explicit consent, separate from AI interview sessions.

The current development bound is **100 MiB (100 × 1024 × 1024 bytes), inclusive,
and 60 minutes of decoded media**. Do not round the byte-boundary test to
100,000,000 bytes. Manual upload streams through a private temporary file and
existing private storage instead of holding the whole request in memory.
Interrupt/error cleanup, disk headroom and concurrency require acceptance.

Processing, transcript/question review, speaker evidence/review and notes are
separate actions. Anonymous speaker separation does not identify a person.
Staff labels must remain source-bound and cannot become biometric proof.

Native provider imports must match the authorized original host/account and
current appointment and select only the intended recording. A media asset from
another meeting or employer must not be importable by changing an ID.

“Download Recording” should download a usable file, not merely open an external
player. Test the download event, filename, media type, playable bytes and
authorization, including after session expiry. Do not make private files public
or remove consent checks to solve a download defect.

## 15. Optional Recall meeting attendance

The latest development feature adds a **visible, silent Zoom assistant**
named **Lexy — Interview Assistant**. It captures audio only. Recall
transcription, video and speaking/coaching/scoring are not enabled by this
feature. No calendar-wide automatic joining is authorized.

### 15.1 Where staff use it

Open the candidate in the relevant work-order context, then **Meeting Notes**.
The **optional meeting capture** panel handles employer workspace authorization,
host approval, dispatch, state, recovery, stop and reviewed import.

The platform administrator authorizes the employer’s connected workspace.
The original managed Zoom host records participant consent and approves the
specific appointment. Approval does **not** dispatch. Dispatch is a second
explicit action. Notices to participants are not substitutes for consent.

### 15.2 Required setup

The connected Recall workspace uses **US West 2**. Before live dispatch:

1. Configure Recall’s development webhook URL at
   `{DEVELOPMENT_API_ORIGIN}/api/meeting-assistant/recall-events`.
2. Put the workspace verification secret into development Secrets as
   `RECALL_WEBHOOK_SECRET`. This is **not** the Recall API key.
3. Confirm the correct webhook signing scheme/account. Newer Recall accounts
   use `webhook-*`; legacy Svix accounts can use complete `svix-*` headers.
4. Confirm employer ownership, original Zoom host and participant consent.
5. Run one authorized dummy meeting and verify the actual callback receipts.

**Handoff update:** `RECALL_WEBHOOK_SECRET` was added to secure configuration
while this pack was being prepared. Its value was not read, the application was
not restarted for it, and runtime loading or real signed delivery was not
verified. The remaining setup/acceptance checks still apply.

The UI’s configured flag checks secret presence, not proof that Recall can reach
the dashboard endpoint. Unsigned callbacks must fail. Raw-body HMAC verification,
five-minute delivery-age checks, hashed replay IDs and event ordering protect
status changes.

### 15.3 State and recovery

| State | Meaning/action |
| --- | --- |
| Approved | Saved human approval; no provider create request yet. |
| Dispatching | Durable create claim exists; do not repeat it. |
| Unknown | Provider outcome is uncertain; recover the saved receipt, never blindly resend. |
| Scheduled/joining/waiting/recording | Provider lifecycle information, not proof of a completed import. |
| Processing/done | Media processing or completed capture; import requires explicit review and consent. |
| Failed | Provider failure; cleanup/reconciliation may still be needed. |
| Stopping/stop requested | Stop/cleanup has been requested; deletion is not yet proven. |
| Deleted | Provider cleanup confirmed for that attempt; this does not erase an already-imported private note. |

Stop remains available when setup is missing or authorization is revoked.
Employer admins can perform eligible recovery/stop without acquiring dispatch
authority. Scheduled cancellation and leaving an active call are different
provider operations. Fatal/call-ended status can precede final media completion;
do not claim deletion of all media before the appropriate final state.

Provider retention is explicitly 24 hours. A reviewed import downloads one
verified, bounded MP3 into existing private notes, then requests provider-media
cleanup. Imported private material follows existing local retention/erasure
controls and does not become an approved assessment automatically.

Workspace/account/appointment changes request cleanup. Candidate erasure holds
completion while unresolved provider recording receipts/media remain. A minimal
durable cleanup intent survives the rollback of a held erasure.

**No real meeting was joined during development verification.**

## 16. ATS overlay: Zoho Recruit and Greenhouse

### 16.1 The universal connector model

Lexy’s common concepts—employer binding, jobs, applicants, evidence, approvals,
attempts, receipts and stage ownership—are separate from provider-specific APIs.
An adapter translates those concepts into each ATS’s identifiers, permissions,
data shape and retry/transition contract.

This architecture supports additional adapters; it does not make every ATS
compatible automatically. A generic connector must not guess that another
provider supports the same writes, scopes, pipeline stages or offer lifecycle.
Customers can use native Lexy hiring, an external ATS as system of record, or a
clearly configured handoff.

### 16.2 Zoho connection and imports

Use **Settings → ATS connections** (`/settings/ats`). The Zoho path is the
employer-bound direct Lexy connection using the configured application
credentials, not an assumption that a project-wide Connect button grants every
employer access.

Authorize the correct data center, complete OAuth, inspect the returned company
and explicitly confirm the employer. Preview before selecting reviewed job,
candidate and application imports. A job ID, candidate ID and application ID are
different identifiers; do not substitute one for another.

Local disconnect revokes local use; it is not permission to delete external
records. Token refresh/expiry, reconnect, account change and employer change must
invalidate stale operations.

### 16.3 Applicant interview campaign

For an approved imported work order with a valid plan:

1. Preview its associated applicants.
2. Review the intended recipients and current eligible application identities.
3. Explicitly authorize the controlled invitation/campaign.
4. Verify delivery, candidate interview completion and current local results.
5. Record an attributable human evaluation and advancement decision.
6. Publish only allowed progress/explicitly approved assessment material through
   the controlled publication path.

This is the intended “Lexy sits on top of our ATS and interviews applicants”
experience. The dummy-job workflow still requires real team submission/independent
approval and controlled acceptance; synthetic evidence is not a substitute.

### 16.4 Write-back boundary

Progress notes and explicitly approved assessment publication are separate from
local review, ATS stage mapping, actual remote advancement and offers.
The write path needs employer-granted write permission and explicit disclosure
approval. Do not publish private learning/career material or unapproved notes.

**Zoho remote application-stage advancement is not exposed as live dispatch.**
Read-only stage metadata, pipeline history, mappings, simulation or a reviewed
handoff must not be labelled “applicant advanced in Zoho.” A supported
application-specific transition contract, employer authorization, durable claims,
read-back and uncertainty handling are prerequisites for execution wiring.
The development implementation already includes controlled local stage requests,
approval/withdrawal/history, a guarded HTTP adapter and source/authority/erasure
fences. Those are not proof of an employer's permitted transition.

### 16.5 Greenhouse and other ATS tools

Greenhouse includes direct employer connection/confirmation, scoped reviewed
intake/linking, individual and reviewed-batch interview preparation and deliberate
approved sending, invitation recovery, and separately approved progress/assessment
note publication. Current controls go beyond the earlier connector foundation.
Real employer permissions, delivery and publication visibility still need team
acceptance. These do not establish universal two-way sync, remote stage execution
or a complete external offer integration.

Ashby, Lever, Workday, SAP SuccessFactors, Bullhorn and other ATS adapters are
not claimed complete by this handoff. Prioritize additional adapters using actual
customer demand, available permissions and explicit acceptance criteria.

## 17. Controlled offers and employer ownership

Offers remain **human-operated and human-approved**. AI assistance is not authority
to issue an offer, change terms, negotiate, make legal commitments or bypass the
employer’s approval process.

Preparation, current version, employer owner, approval, send receipt, uncertain
delivery and candidate response must remain distinct. Editing approved terms
requires fresh approval of the changed version. The eligible owner must belong
to the employer/authorized handoff, not merely an agency that sourced a candidate.

Where the customer uses an ATS/HR system, configure the strategic stop/handoff:
Lexy can deliver reviewed evidence and an authorized decision; the employer’s
system/HR retains final offer control unless a separately approved controlled
integration is actually implemented and accepted.

An accepted synthetic test offer is not employment, identity proof or an automatic
fee trigger. Fees and origin evidence have their own rules; do not use the
candidate-response UI as billing authority.

## 18. Candidate portal, development and learning

Candidate-facing functions include profile/onboarding, applications and interviews,
prep/practice, career conversation/reporting, privacy settings and learning/growth.
Learning work includes courses, completion/progress, assessments/reassessments,
voice progress cycles and private encouragement/rewards.

Registration/admin discovery and employer hiring must not consume private
development evidence by accident. Learning data is candidate-owned; tenant
membership alone is insufficient to read another candidate’s records.
Private rewards/credits are not money or an employer performance score.

Like-for-like evidence is required for meaningful reassessment/progress claims.
Training completion and new evidence should be respected; a larger amount of
text or repeated fixture should not produce an invented improvement.

Candidate-facing score framing should be constructive and evidence-based.
Paused discovery and privacy changes apply to current/historical visibility
surfaces such as “who viewed you.” Alert subscriptions, quiet email, withdrawn
interest and consent to expose an employer’s role are different choices.

## 19. Analytics, notifications and operational visibility

The app includes job/candidate analytics, decision queues, agent/run history,
activity feeds, operational notifications, reports and governance surfaces.
Counts and linked views should use the same predicates and privacy/compliance
filters. A dashboard zero can mean no eligible evidence, not necessarily a defect.

Inspect the exact job/tenant/filter context when reconciling a count.
Closed/terminal stages, manual placement and source attribution must not be
confused with active board lanes or agent-executed transitions.

Client/server telemetry, HTTP access logging and provider/queue state support
investigation. Do not put candidate transcripts, auth tokens, full webhook
payloads or secret-bearing links into a broadly shared defect report.

## 20. Complimentary testing, tiers and usage economics

The product retains commercial tier concepts and a complimentary Enterprise
pilot/code capability for approved internal testing. The user’s stated testing
goal is full access without Lexy charges while actual costs are investigated.

This is not authority to disable privacy, approvals, provider permissions,
erasure fences, safe retries or external spend visibility. Third-party providers
may still charge for calls. “Free internal access” does not mean zero vendor cost.

Usage observation records fixed operation labels, bounded units and eligible
receipts while retaining **unknown cost** where billing cannot be proven.
Measured bytes, audio duration, characters and API success are not automatically
billed units or verified prices. Invoice/account reconciliation is deferred.
Do not repair an old missing receipt by re-executing a real candidate action.

Do not activate Stripe/self-service billing or alter live allowances to pass a
test. Existing billing warnings must be assessed by the owner rather than
silently acknowledged with new configuration.

## 21. Privacy, security, fairness and erasure

### Authorization and isolation

Test anonymous, candidate, suspended staff, wrong-role, foreign-employer,
unassigned-requisition and changed-session cases. Repeat direct by-ID reads,
list/count/export/download and child-row reads. API credentials and provider
connections are not user authentication.

### Consent and confidentiality

Consent precedes capture and is rechecked at relevant runtime operations.
Only offered calendar slots may be disclosed. Private development, recordings,
speaker labels, assessment drafts and confidential roles have separate
publication boundaries. Assessment approval is not universal disclosure consent.

### AI and fairness

Existing fairness/redaction/rubric rules must remain intact. Protected
demographics and non-scored work authorization must not be fed into job-related
scoring as prohibited hiring signals. Adverse-impact analysis requires the correct
candidate/job unit and stage semantics; small test samples are not a fairness
certification or legal opinion.

### Erasure

Candidate erasure spans canonical/indirect ATS identities, background writes,
queues, media pointers, stored files and account ownership. Revocation must fence
late writes, not merely remove the visible row. Provider cleanup and uncertain
external email/recording outcomes can hold completion honestly.

Shared/cross-region identities and staff/candidate dual-role accounts need their
documented treatment. Do not delete a staff account simply because it is linked
to a candidate request. Export and erasure tests are destructive/privacy-sensitive;
run them only on disposable approved fixtures.

### Compliance boundary

Governance documents and software controls are not legal certification,
SOC 2 certification, independent bias audit or an assertion of global EEO/GDPR/
AI Act compliance. Assign legal/security owners for the applicable jurisdictions.

## 22. Configuration and provider setup

No secret values are included. The team must inspect existing configuration
through its authorized secure tools, not copy `.env` or database dumps into this pack.

| Area | Configuration/ownership check |
| --- | --- |
| Application/session | Existing session/auth origin/cookie settings; `SESSION_SECRET` through secure configuration only. |
| PostgreSQL/storage | Approved external target; existing connection and private S3/object-storage configuration, encryption/tags and permissions. |
| AI/speech | Existing OpenAI/Azure/Deepgram/ElevenLabs credentials and configured routing. `AZURE_TTS_KEY`, `AZURE_TTS_REGION`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` names are configuration references, not instructions to replace working values. |
| Email | Existing SES/Graph sender/account configuration; `SES_SNS_TOPIC_ARNS` for allowed topic ARNs and `INBOUND_EMAIL_SECRET` for the protected inbound/SES callback path. |
| Zoho | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`; correct provider data center and exact registered callback from ATS settings. |
| Google/Microsoft/Zoom | Active staff-owned account binding, current OAuth permissions, approved employer and managed appointment. |
| Recall | Connected workspace, employer grant and separate `RECALL_WEBHOOK_SECRET`; signed lifecycle callback; original Zoom host consent. |

`SES_SNS_TOPIC_ARNS` contains **topic ARNs**, not subscription ARNs with a trailing
subscription UUID. SNS confirmation/delivery also needs the existing inbound
authentication arrangement and valid SNS signature/allowlist behavior.
Use the owned environment’s endpoint
`/api/webhooks/ses-events`. Never share a secret-bearing URL in the workbook.

Use development callback origins for development and production origins for
production. A “configured” screen and a reachable endpoint alone do not prove
delivery, permission or correct account ownership.

## 23. Database changes and release operations

The source migration directory currently reaches
`0112_meeting_attendance.sql`. File presence is not proof of deployment.
Recent recording/meeting changes include:

| Migration | Purpose |
| --- | --- |
| `0105_meeting_notes.sql` | Private human meeting-note/media evidence foundation. |
| `0106_meeting_question_review.sql` | Question review. |
| `0107_meeting_notes_shared_erasure_barrier.sql` | Shared erasure fencing. |
| `0108_meeting_speaker_evidence.sql` | Speaker evidence/review. |
| `0109_native_meeting_recording_source.sql` | Provider recording provenance and deduplication. |
| `0110_staff_google_meet_recordings.sql` | Staff-owned native Meet recording authorization. |
| `0111_meeting_recording_bounds.sql` | Current recording bounds. |
| `0112_meeting_attendance.sql` | Service-private workspace grants, attempts, event replay IDs and cleanup intents; erasure/deletion safeguards. |

These recent changes were applied/verified in development as described in their
dated notes; **the external production database must be independently checked**.
Do not execute these filenames blindly or assume the migration ledger matches
an already-existing manually modified schema.

Before any production rollout: identify the actual API/database targets, take
an owner-approved backup, review dependencies/security DDL, execute the approved
migration plan, verify policies/triggers/constraints and private storage, then
run approved production smoke checks. Avoid schema-push shortcuts that may
remove security policies/triggers.

No destructive SQL, migration, production check, workflow restart or provider
write is performed by the documentation builder.

## 24. Verification evidence and its limits

| Evidence | Recorded outcome | Scope and limitation |
| --- | --- | --- |
| Latest combined development regression, November 8, 03:22–03:40 UTC | 60/60 groups; 1,290 API tests in 134 files; 283 frontend logic tests; ten browser groups; schema/type/build/guard/lint/format checks | Includes the current attendance and Zoho development paths; intercepted/synthetic evidence is not live provider or manual acceptance. |
| Full combined development regression, November 5, 12:23–12:39 UTC | 56/56 groups; 1,190 API tests in 121 files; 283 frontend logic tests; ten browser groups; schema/type/build/guard/lint/format checks | Predates later Recall attendance and a separate SDK-only follow-up; not live provider acceptance. |
| Recording upload reliability | Streaming/private temporary-file path; bounded/interrupted/overlapping upload coverage; existing 100 MiB/60-minute development limits | Synthetic HTTP/SDK/storage checks do not establish production bucket permissions or capacity. |
| Recall attendance focused automated checks | 9 tests | Validation, signing, provider contract, no-resend and HTTP authorization conditions; mocked provider. |
| Recall database-backed service checks | 8 checks, rollback-only private fixtures | Durable claim, state/order/recovery/authorization/cleanup service behavior; not live provider deletion. |
| Recall browser check | Desktop and 390px fixture journey passed | Real React component with intercepted auth/API; approval/dispatch/import/403-cache behavior; not a live signed-in provider meeting. |
| Post-change build and runtime | Frontend/API typechecks and API build/guards passed; servers restarted; health 200, unsigned callback 401 | Confirms startup/basic rejection; does not prove signed Recall delivery or all app journeys. |

Historical evidence source:
`docs/qa/independent-reliability-and-release-handoff-2026-11-05.md`.
Recall source: `docs/engineering/recall-live-attendance.md` plus the current
focused test files and this handoff’s evidence register.

The workspace’s named workflow status and a separately invoked completed
regression can differ. Preserve exact command, time, build and report location.
Do not convert a timed-out or missing final report into a pass, and do not
represent an old failed workflow badge as proof that the newer dated run failed.

### Suggested developer commands, development only

```sh
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/lexy run typecheck
pnpm --filter @workspace/api-server run build
pnpm test:assisted-baseline
```

The full baseline takes materially longer than focused checks and may run
isolated schema/HTTP fixtures. Read its script and target guard before execution;
never point it at production. Run once on the exact candidate build, retain its
final report and report new failures rather than guessing from partial logs.

The Recall rollback-only SQL helper requires a separately verified development
fingerprint. Do not invent/reuse a historical fingerprint, remove the guard or
run it against an unknown database. The IT workbook focuses on human acceptance;
developer regression commands are additional evidence, not replacements.

## 25. Remaining gaps and the Noon comparison

### Latest authentication increment

Password-confirmed **Sign out all devices** is available in staff personal
Settings and candidate Account Settings. It is self-only, requires explicit
acknowledgement and atomically couples account epoch rotation to a private
control-plane audit. It does not change the password or ordinary session-only
logout. Read `All-Device-Signout-Verification.md` for current evidence and
limitations, especially organization-only SSO accounts and process-local
confirmation rate limits. Deploy **0113 → 0114 → 0115** before coordinated API
replacement. Development only; team acceptance is still pending.

### Earlier increment: account credential epochs

Account-wide password-change invalidation and cross-process/restart revocation
proof are no longer pending development items. Read
`Credential-Session-Replica-Verification.md` for the exact local evidence,
limitations and deployment order. Normal logout remains session-specific.
Migrations 0113 and **0114** are required before all API replicas run this build.
Live provider acceptance and external production verification remain separate.

### Earlier same-day increment: session revocation and manual handoff

See `Session-Handoff-Contention-Closeout.md` in the current pack. Logout now
revokes the selected credential server-side, not just the browser cookie.
Migration `0113_session_revocations.sql` must precede external deployment to all
API replicas; it was applied only in development. Other same-account sessions
remain valid. Manual employer handoff can now be recorded against an approved,
exported, current packet, with human acknowledgement and a safe reference.
The record is human-reported only, not a verified ATS receipt or offer send.
Local 16-recipient/eight-worker contention and interrupted-attempt preservation
passed. This does not complete live ATS stage writes, external offers, provider
acceptance, account-wide password-reset revocation or production capacity proof.

### Final independent handover increment — November 10

Platform administrators have **Mail Holds** (`/platform/mail-holds`) for a
metadata-only review of reserved replies, reminders and candidate cadence emails.
They can record an evidence reference and retain a review or close it without
resending. Both outcomes retain the original send hold. A review never claims
provider acceptance or delivery, sends email, releases a claim or changes hiring
state. Stale/concurrent decisions are rejected; reviews are atomically audited.
Offer, erasure, post-hire claim and outreach-specific ledgers remain separate.

Private weekly bell notifications can recover from accepted identity-bound
receipts without sending another email. Recovery preserves original reporting
dates/read state and uses generic historical copy when original metrics were not
retained. Changed ownership, email, DNC or erasure fences recovery.

The refreshed pack includes Source-Version.json, with the base Git revision and
an exact content digest over allowlisted code/config/schema files. Match that
digest for testing; it excludes media, ignored files, secrets, database data and
generated binaries. The download pack is documentation and test instructions,
not a source-code archive or production deployment certification.

The historical competitor comparison concerns **Noon**, not Noom. This pack
documents Lexy; it does not make fresh unsupported claims about Noon’s current
features, reach, compliance or performance.

| Item | Classification | Owner/next evidence |
| --- | --- | --- |
| LINX attributable approval and complete dummy-applicant journey | Human acceptance pending | Work-order author, independent reviewer, recruiter and candidate tester. |
| Google/Outlook/Zoom live lifecycle, calendar privacy and native media imports | Owned-account acceptance pending | Authorized host/IT provider owners. |
| Recall signed callback and one live consented Zoom capture through cleanup/import | Secret added; callback/runtime verification + live acceptance pending | Recall workspace owner and original Zoom host. |
| Zoho controlled applicant campaign and allowed note publication | Live acceptance/permissions pending | Employer admin, recruiter and dummy candidate; do not infer permission from OAuth success. |
| Zoho remote application-stage advancement | Local request preparation, approval, withdrawal, history and locked recovery implemented; live dispatch unavailable | Cross-process/crash checks plus 40 concurrent-ordering checks of the SQL barrier and combined source fence passed in an isolated cluster. Verified transition evidence, live execution wiring, deployed/request-role and real-erasure-service checks, and safe live acceptance remain. See `docs/engineering/zoho-controlled-stage-writer.md`. |
| Additional ATS adapters and complete external offer handoff | Product/build scope, not implied finished | Prioritize a specific customer/provider; foundation alone is insufficient. |
| Combined development regression | Passed November 8: 60/60 groups | New code changes require proportionate revalidation; this does not replace LINX or live provider acceptance. |
| Production schema, storage, SES, capacity, origins and rollout | Operator acceptance pending | External hosting/database/cloud owners. |
| Vendor bill reconciliation and final pricing guardrails | Deferred business/operations work | Finance/provider account owners; no internal pilot paywall implied. |
| Independent legal/security/fairness and scale evidence | Separate assurance work | Qualified legal/security/operations reviewers. |

Native functionality, ATS overlays and live-meeting features are different
acceptance tracks. Do not claim full Noon parity or “all gaps closed” because
the six native workflow steps pass.

## 26. IT test execution, defect reporting and sign-off

### 26.1 Recommended order

1. Freeze/record the development build and assign testers.
2. Run the workbook’s **Smoke** selection and confirm there is no environment/
   auth/candidate intake/blocking approval defect.
3. Run **E2E** journeys using the same dummy identities end to end.
4. Run all relevant module tests, especially privacy/negative/recovery cases.
5. Run separately approved live-provider cases and controlled load/erasure tests.
6. Run the current full developer regression once on the final acceptance build.
7. Triage, fix, retest failed cases and obtain role-specific sign-off.

### 26.2 Result and priority definitions

| Result | Meaning |
| --- | --- |
| Not Run | Not executed by the assigned tester for this build/environment. |
| Pass | All stated expected results observed and evidence retained. |
| Fail | At least one expected result violated. Link a defect. |
| Blocked | Setup, permission, upstream outage or missing prerequisite prevented execution. |
| Not Applicable | Owner-approved exclusion with a documented reason; not a hidden failure. |

**P0:** privacy/isolation, unauthorized communication/recording/offer, data loss,
consent bypass or a core journey blocker. **P1:** material functional/recovery
failure. **P2:** secondary usability/consistency defect. Defect severity is
triaged independently of test priority.

Do not overwrite the expected result to match what happened. Keep tester,
execution date, environment/build, actual outcome, evidence, defect and retest
reference. Record the **source** of evidence: UI, network response, provider
receipt or authorized backend state.

### 26.3 Definition of ready for controlled rollout

No unresolved release-blocking P0 defects; all required P0/P1 cases passed or
explicitly dispositioned by the release owner; required provider journeys
accepted with real authorized accounts; exact-build regression complete; schema/
storage/origin/consent/operator checks complete; legal/security disposition
recorded where required; rollback and incident owners named.

Counts/formulas in the workbook assist triage but never grant release approval.
A blocked live-provider case is not a passed case. An N/A selection cannot hide
a prerequisite of the selected launch scope.

## 27. Troubleshooting and recovery

| Symptom | Check first | Do not do |
| --- | --- | --- |
| Draft missing from Approvals | Open work-order detail; submit for review; use a different eligible approver. | Bypass self-approval or force database status. |
| Registration saved but not visible | Platform candidate registrations; current environment, consent and list filters. | Force every registrant into the shared pool. |
| Interview hangs/code repeats | Correct environment/link, current verification/session state, network errors and recovery UI. | Mint new sessions or resend repeatedly without diagnosis. |
| Interview misunderstands answer | Recorded audio versus saved transcript; device/echo/capture diagnostic and review trigger. | Change stabilized models/rubrics speculatively. |
| No invite after Interested | Saved reply, required staff review, work-order approval, dedupe and delivery receipt. | Blind duplicate send. |
| Invalid provider client/account | Exact callback/data center/client configuration and employer/account confirmation. | Paste credentials into tickets or swap to an unrelated account. |
| Candidate sees calendar details | Stop testing, retain sanitized response evidence and file P0 privacy defect. | Treat it as cosmetic. |
| Recording opens rather than downloads | Browser download event, authorized download response, headers/type/file bytes. | Make the object public. |
| Recall dispatch disabled | Workspace grant, original host, managed Zoom appointment, consent and webhook setup. | Disable consent or signing. |
| Recall state unknown | Recover the existing opaque receipt; inspect safe provider references. | Dispatch a second assistant. |
| Cleanup/erasure pending | Remote completion/cleanup receipt and durable stop intent. | Delete the receipt or mark deletion complete. |
| Zoho stage did not change | Determine whether this was mapping/export versus an actual supported writer. | Claim local simulation changed the remote ATS. |

## 28. Source reference index and technical appendices

Primary current references:

- `artifacts/lexy/src/App.tsx` — implemented application routes and route-level roles.
- `lib/api-spec/openapi.yaml` — published operation contracts.
- `artifacts/api-server/src/lib/recruiting-workflows.ts` — current evidence journey.
- `docs/qa/independent-development-closeout-2026-11-08.md` — latest combined regression and current acceptance limits.
- `docs/qa/independent-reliability-and-release-handoff-2026-11-05.md` — historical regression and operator release checklist.
- `docs/qa/development-gap-closeout-2026-11-04.md` — dated prior fixes and superseding evidence notes.
- `docs/qa/linx-testing-handoff-2026-11-04.md` — controlled team sequence.
- `docs/zoho-recruit-integration.md`, `docs/zoho-interview-campaigns.md`,
  `docs/zoho-interview-notes.md`, `docs/zoho-stage-handoff.md`,
  `docs/zoho-release-checklist.md` — specific Zoho capabilities and unfinished writes.
- `docs/engineering/ats-connector-foundation.md` — Greenhouse/adapter foundation.
- `docs/engineering/calendar-and-meeting-integration-scope.md` and provider-specific notes — calendar/meeting boundaries.
- `docs/engineering/human-interview-notes.md` and `docs/engineering/recall-live-attendance.md` — human evidence and optional live capture.
- `docs/engineering/usage-economics-metering.md` — observation versus billed cost.
- `docs/learning-pilot-foundation.md`, `docs/learning-pilot-courses.md`,
  `docs/learning-pilot-reassessment.md`, `docs/learning-pilot-voice-progress.md` — private candidate development.
- `docs/PII_HANDLING.md`, `docs/AI_SYSTEM_CARD.md`, `docs/ANNEX_IV_TECHNICAL_DOCUMENTATION.md` — governance material; not certification.

Older guidebooks and phased rollout documents contain historical boundaries and
roadmaps. Prefer current code and the latest dated evidence when they conflict.
This handbook is an as-built handoff, not a promise that every historical roadmap
item has been delivered.
