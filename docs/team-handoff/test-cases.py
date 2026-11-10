"""Curated IT acceptance cases. No application/provider/DB actions are executed."""
from pathlib import Path
import re

CASES = []
GROUPS = []


def group(code, name, path, role, setup, dependency, cleanup, rows):
    GROUPS.append({"code": code, "module": name, "path": path, "role": role,
                   "setup": setup, "dependency": dependency, "cleanup": cleanup})
    for line in rows.strip().splitlines():
        priority, title, steps, expected = [x.strip() for x in line.split("|")]
        number = sum(c["group"] == code for c in CASES) + 1
        CASES.append({
            "id": f"{code}-{number:02}", "group": code, "module": name,
            "title": title, "priority": priority, "role": role, "path": path,
            "preconditions": setup, "steps": steps.split(" > "),
            "expected": expected, "dependency": dependency, "cleanup": cleanup,
            "mode": "Controlled acceptance" if dependency != "Development app" else "UI / API acceptance",
            "status": "Not Run", "source": "Handbook + current module/route inventory",
        })


group("ACC", "Authentication, roles and sessions", "/login", "All test personas",
      "Two approved test employers; active and suspended staff; two candidate accounts; separate browser profiles.",
      "Development app", "Sign out test sessions; retain only sanitized evidence.", """
P0 | Staff login and sign-out | Sign in as assigned recruiter > Open Dashboard > Sign out > Reopen a protected URL | Correct identity/role is shown; sign-out removes usable protected access; no prior private page is exposed.
P0 | Candidate cannot use recruiter APIs | Sign in as candidate > Open /jobs and /settings/ats directly > Replay one staff API request with the candidate session | Staff-only data and mutations are denied server-side; no candidate/employer data leaks.
P0 | Suspended staff loses access | With owner approval suspend only the disposable staff fixture > Reuse its existing session > Read a candidate and attempt an action | Fresh authorization rejects the suspended account; cached private data/actions are hidden.
P0 | Foreign employer by-ID isolation | As employer B staff replay employer A job/candidate/detail/export URLs > Compare missing and foreign-record outcomes | Neither records nor ownership/existence details leak; no mutation occurs across the boundary.
P0 | Unassigned recruiter ceiling | Compare assigned recruiter and unassigned colleague on one job > Test detail, interview, candidate action and download APIs | Only eligible assignment/scope permits actions; shared tenant membership alone does not grant access.
P0 | Same-page identity change | Load private candidate data > Change/logout the signed-in identity in a second tab > Trigger refresh/poll/action | Fresh denied reads remove stale private details and do not leave actionable success notices.
P0 | CSRF and anonymous mutation rejection | In an approved API harness submit a state-changing request without auth > Repeat with mismatched Origin on cookie auth | Unauthorized/cross-origin operations are rejected; no outbound action or data change occurs.
P1 | Invalid or expired public token | Open an expired dummy interview/booking/offer token > Try its action endpoint > Repeat with a random token | Clear unusable-link outcome; no token renewal, record disclosure or unauthorized action.
""")

group("WKO", "Work orders, staffing, ICP and approval", "/jobs", "Author; independent reviewer; recruiter admin",
      "Disposable employer work order; author and different eligible reviewer; no real candidate recipients.",
      "Development app", "Archive the dummy work order after dependent tests; do not delete active provider receipts.", """
P0 | Create and persist a draft | Create a labelled draft with title, description and client > Save > Reopen detail/list | Exactly one draft persists with correct employer and fields; saving is not approval or execution.
P0 | Draft submission and Approvals visibility | Open draft detail > Submit for review > Open the reviewer Approvals screen | Pending review appears for eligible reviewer; draft-to-review state is clear and no self-approval occurs.
P0 | Author cannot self-approve | As author open approval controls > Replay the approval request directly | Self-approval is denied; reviewer history/status remains unchanged.
P0 | Independent approval and unapproved interview gate | Attempt invite/start on unapproved job > Approve as independent reviewer > Retry intended approved action | Unapproved action is blocked; approved job becomes eligible without fabricating approval or duplicating invites.
P1 | External requisition number and roster | Save external client requisition number and multiple recruiters > Reopen and reassign the team | External number is distinct from Lexy number; one job has the intended roster/lead, not duplicate work orders.
P1 | ICP edit and cleared location | Edit job ICP skill/location > Explicitly clear location preference > Reopen and preview discovery | Saved ICP persists; deliberately cleared location does not silently fall back to old job location.
P0 | Interview plan validation and job context | Create a job-specific plan > Submit an empty/malformed plan through approved negative API test > Reopen valid plan | Invalid/empty questions are rejected; valid plan retains authorized job context and does not alter existing plans.
P1 | Stale work-order/plan revision | Open approval/plan in two tabs > Change material content in one > Submit the stale operation from the other | Server detects current authority/revision where required; old review is not silently reused.
""")

group("CAN", "Candidate registration, pools and intake", "/platform/candidate-registrations; /candidates", "Candidate; platform admin; recruiter",
      "Unique synthetic registration identity; approved test employer; consent choices documented.",
      "Development app", "Use approved export/erasure fixture cleanup after all candidate-dependent tests.", """
P0 | Public registration to admin visibility | Register a synthetic candidate through the actual candidate entry flow > Verify account entry > Open platform candidate registrations as admin | Registration is recoverable in the correct environment/admin surface; shared-pool eligibility is not automatically granted.
P0 | Registration privacy and existence oracle | Repeat registration with known versus new dummy email in an approved harness > Compare public response status/body > Inspect returned identifiers/tokens | Public response does not disclose account existence or mint unauthorized access.
P0 | Candidate discovery consent boundary | Register without shared discovery opt-in > Search employer/shared discovery > Opt in explicitly and repeat > Revoke and repeat | Eligibility follows current consent; employer visibility is not created merely by registration.
P1 | Duplicate email admission | Import/create the same normalized email twice in the same employer > Review any merge prompt > Repeat from async intake path | No duplicate canonical person or 500; review/merge behavior is explicit and tenant scoped.
P1 | Resume file-type and skill persistence | Upload labelled PDF and DOCX resumes through supported intake > Reopen/download > Check extracted skills against existing skills | Supported types remain usable; file extension/content type is correct; existing skills are not silently discarded.
P0 | Platform-pool filtered record access | With test consent withdrawn or candidate DNC/erased use list, search and direct by-ID reads as employer | Restricted rows stay excluded across list/detail/count/export surfaces, not just one list.
P1 | Internal employee sourcing distinction | Mark a dummy client employee through authorized UI > Run internal mobility and normal sourcing views > Deliberately remove flag if supported | Employee eligibility is employer-specific and controlled; internal sourcing does not become global platform discovery.
""")

group("SRC", "Sourcing, enrichment and matching", "/sourcing; /jobs/:id", "Assigned recruiter",
      "Approved dummy job/ICP; internal candidates with known skills; explicitly approved provider test budget and synthetic query.",
      "External provider for live cases; internal-only cases need app only",
      "Stop created runs; remove only approved disposable imports; retain safe request receipts.", """
P0 | Internal discovery before external request | Review internal discovery for approved job > Capture internal-review marker > Confirm whether an external action was explicitly requested | Internal evidence is genuine; internal gate is not misreported as paid activation and no unapproved external request occurs.
P1 | Real external sourcing receipt | After approval run one bounded real external query > Inspect candidate provenance and safe provider receipt | Results correspond to actual provider response; demo/simulated data is labelled and not presented as a live provider result.
P1 | Enrich Layer current account acceptance | Select one approved dummy/public profile fixture > Trigger one permitted enrichment > Compare provider and saved result | Genuine success/empty/error is shown; missing fields and unknown cost stay honest.
P1 | Empty, rate-limited and failed provider response | In a development fault harness return zero results, 429 and timeout separately > Run the same operation once per condition | Useful empty/error state; no fabricated candidates or unlimited retries; uncertainty is visible.
P1 | Remote and no-location preference | Compare approved remote job and cleared-location ICP against city-specific control > Inspect query constraints and results | Remote/no-preference search is not incorrectly hard-pinned to an old city.
P1 | Natural-language search and scoping | Submit a job-related natural-language candidate query > Verify meaningful matches > Repeat as foreign/unassigned caller | Valid request works within scope; failed generation is explicit; no private/foreign results leak.
P0 | Match score source consistency | Compare candidate list, job detail, intelligence and decision view after new interview evidence > Include null and real-zero fixtures | Accumulated job-specific evidence is current; null is missing, real zero remains zero, and no random fallback replaces stored evidence.
P0 | Private career data does not affect fit | Record baseline fit for dummy job > Change only private candidate career/learning evidence > Re-evaluate through approved test harness | Employer-facing scoring inputs exclude private developmental data; explain any score movement using permitted evidence only.
""")

group("ENG", "Outreach, replies, inbox and delivery", "/outreach; /outreach/inbox", "Assigned recruiter; controlled candidate tester",
      "Approved job; one consenting controlled inbox; reviewed draft; any email sends explicitly approved by owner.",
      "Owned email account / SES or Graph", "Stop dummy follow-ups; retain provider receipt but not message secrets.", """
P0 | Edit draft before approval | Generate or open dummy outreach draft > Edit content > Save and inspect the candidate/job destination | Edited version persists for the right recipient; no send occurs during draft/save.
P0 | Single approved first-touch send | Approve exact draft and recipient > Send once > Repeat the action/refresh > Check provider receipt and inbox | One intended message; no duplicate first-touch; queued/provider accepted and inbox delivery remain distinct.
P0 | Interest before sourced interview invite | Send approved interest check > Candidate clicks Interested > Review saved reply > Approve and send interview invite | Intended ordering holds; interview is not sent first or repeatedly; current consent/review gates are enforced.
P1 | Branding and action origin | Inspect delivered outreach/invite on desktop/mobile > Check Lexy logo, employer attribution, reply address and action-link destination | Consistent readable branding and correct owning environment; no wrong-origin or secret-bearing debug link.
P0 | Uncertain send does not resend | Inject provider-accepted/receipt-lost outcome in approved harness > Refresh/retry > Inspect attempt history | Uncertain delivery is held for reconciliation; no automatic duplicate message.
P0 | DNC/withdrawn/quiet distinctions | Apply each candidate communication control separately on dummy fixtures > Trigger eligible contact/alert paths | DNC/withdrawal/quiet semantics are enforced; settings do not silently restore discovery or subscriptions.
P1 | Reply sync, inbox pagination and ownership | Reply from controlled inbox > Sync > Page/filter inbox and unread count as assigned and foreign staff | Reply is persisted once, scoped and visible on the correct page; counts/notification recipients agree.
P0 | SES callback authentication and receipts | IT verifies an authorized synthetic SES event at the correct environment endpoint > Check topic allowlist/signature and auth > Replay safely | Valid event produces expected receipt state; invalid auth/topic/signature fails; replay cannot create duplicate candidate communication.
""")

group("INT", "AI interview delivery and capture", "/interviews; /interviews/:id/room", "Candidate tester; assigned recruiter",
      "Fresh approved dummy interview, supported browser/devices, explicit recording consent and controlled inbox.",
      "Configured AI/speech and private recording storage",
      "Finish or safely stop sessions; keep consented diagnostic media private.", """
P0 | Invitation, verification and correct session | Send one approved dummy invitation > Open link > Complete code/access verification > Refresh once | Correct job/session opens; no endless loading, unnecessary new code loop or duplicate session.
P0 | Consent before device/provider use | Open fresh session > Decline required consent and inspect device/provider activity > Repeat with consent | No capture or consent-protected processing before required consent; accepted path becomes usable.
P1 | Fresh introduction | Start at question one with working speakers > Listen and record displayed/spoken intro | Lexy introduces herself and asks intended first question; no unexplained resumed-question greeting.
P0 | Candidate voice not assistant echo | Use headphones and answer distinctly > Pause silently after Lexy speaks > Compare source recording and saved answer | Lexy's own speech is not submitted as candidate evidence; no self-answer or phantom response.
P0 | Long answer and trailing words | Give a 60–90 second answer with pauses and a distinct final sentence > Wait for endpoint > Compare saved text/audio tail | Interim speech extends capture appropriately; trailing words are retained and not cut off early.
P0 | Explicit unknown skill adaptation | State clearly that the candidate does not know a named job skill > Give a known skill > Inspect next question and saved evidence | No fabricated competence or unsupported assumption; targeted clarification/adaptation respects the stated gap.
P1 | Conditional weak-audio review | Use approved weak/noisy/ambiguous sample without changing models > Inspect review-trigger diagnostics and screen > Confirm or re-record when triggered | Review controls are visible when required; normal high-confidence answers need not show review every time.
P0 | Refresh and continue | Answer first question > Refresh same browser during second > Follow Continue/resume path > Finish | Saved evidence remains; resume screen/greeting is honest; no reset, duplicate answer or lost recording segment.
P0 | Temporary network failure and retry | Disconnect network briefly during save/upload in dummy session > Restore > Use documented recovery | Visible failure/recovery; existing saved answers are retained and retries do not double-submit evidence.
P1 | Device denial and recovery | Deny microphone/camera separately > Inspect explanation > Grant supported permission and retry | Clear device-specific guidance; no false Listening/Recording status while capture is unavailable.
P0 | Exactly-once finish and grading handoff | Complete final answer > End session > Repeat End/refresh > Inspect persisted completion/evaluation work | One coherent completion and grading handoff; no duplicate scoring, missing summary or false success.
P0 | Recording playback and actual download | Open authorized interview recording tab > Play audio through tail > Click Download Recording and inspect browser download/file | Download produces a nonempty playable file with correct filename/type rather than only a new player tab.
P0 | Candidate cannot see employer interview results | As interview candidate view portal and guessed results URL > As assigned recruiter inspect same evaluation | Candidate only receives allowed portal content; confidential employer evaluation is not exposed.
P1 | Mobile camera overlay and answer controls | Repeat capture/review/finish at supported mobile width with camera enabled > Rotate where supported | Prompts and required review/action buttons remain readable/clickable without being hidden by camera.
""")

group("EVA", "Verification, evaluation and human decisions", "/human-review; /decision-queue; /jobs/:id", "Eligible reviewer; hiring manager",
      "Completed dummy interview plus intentionally insufficient identity fixture; independent human evidence/reviewers available.",
      "Development app", "Preserve test review history; do not label synthetic identities as real verified people.", """
P0 | Identity is not cleared by AI opinion | Create insufficient identity evidence > Record AI suggestion/manual note > Attempt verification completion | Advice alone cannot clear identity; required human corroboration or explicit workflow-only synthetic clearance stays distinct.
P0 | Completed evaluation and score refresh | Finish the dummy interview > Wait for eligible queue work > Reopen evaluation and job match views | Current completed evidence and nullable scores are persisted/refreshed consistently; queue failure is not disguised as success.
P0 | Human evaluation approval tied to evidence | Review current dummy evaluation > Approve as authorized reviewer > Introduce a changed evidence revision in controlled test | Old approval cannot silently authorize changed evidence; attributable reviewer/version is retained.
P0 | Correct a decision with history | Record human dummy decision > Use supported correction > Inspect latest outcome/history/queue | Corrected current decision controls the workflow while prior decision and attribution remain auditable.
P0 | Human decision before downstream offer | Attempt offer continuation before required evaluation/decision > Complete authorized human steps > Retry intended preparation | Pending/failed evidence cannot auto-clear; AI recommendation alone is not final hiring or offer authority.
P1 | Fairness and non-scored information boundary | In approved synthetic evaluation include protected demographic and work-auth fixtures > Inspect scoring inputs/results/audit | Prohibited/private data stays out of scoring; work authorization uses the separate non-scored boundary.
P1 | Consistent proctoring signal explanation | Use known threshold fixtures > Compare signal status, aggregate risk, flags and notes | Displayed pass/fail thresholds and derived risk/explanations agree; no automatic misconduct claim.
""")

group("CAL", "Candidate scheduling and calendar privacy", "/coordinator; candidate booking link", "Recruiter; host; candidate tester",
      "Approved dummy appointment; separately consented staff calendar accounts; offered slots and two candidate test sessions.",
      "Owned Google / Microsoft calendar accounts", "Cancel dummy appointments through managed operations; verify provider cleanup.", """
P0 | Candidate sees only offered slots | Staff offers a limited slot set > Open candidate booking in clean browser > Inspect all calendar API responses | Only approved eligible slots are disclosed; no full calendar, event titles, attendees or unrelated busy details.
P0 | Slot booking ownership and expiry | Candidate books valid offered slot > Try foreign candidate token and expired slot link > Inspect appointment | Valid booking binds correct applicant; invalid/foreign/expired requests cannot mutate or expose an appointment.
P0 | Concurrent booking conflict | Two controlled sessions submit same last slot near-simultaneously > Inspect local/provider state | Only one valid reservation succeeds; loser gets explicit conflict; no double booking or duplicate invites.
P0 | Stale slot after host edit | Load offered slots > Host changes availability/roster > Submit the now-stale selection | Current constraints are rechecked; outdated offer cannot force a conflicting booking.
P1 | Candidate time-change request | Request a new time through candidate UI > Inspect staff queue > Accept via eligible staff action | Request and confirmed reschedule are distinct; no external booking is claimed before successful authorized action.
P1 | Withdraw time-change request | Submit request > Withdraw before staff decision > Refresh both views and try stale staff approval | Withdrawal is recorded; no appointment cancellation or stale request execution occurs.
P0 | Reschedule and cancel consistency | Authorized host reschedules then cancels dummy appointment > Inspect local state, provider, candidate link and messages | One current authoritative appointment; old details are invalid/clear; uncertain provider state is not marked confirmed.
P0 | Host/panel account ownership | Try changing host/account/panel from a stale tab and as unrelated host > Refresh conflicts | Original ownership and current roster/revisions are enforced; no unrelated staff calendar is exposed.
P1 | Timezone and daylight-saving boundary | Offer slots across two tester timezones and one DST transition fixture > Book and compare provider/local time | Same instant is preserved and displayed with clear timezone; no one-hour/date drift.
""")

group("GGL", "Google Calendar, panels and Meet links", "/calendar-preferences; /coordinator", "Authorized staff Google host",
      "Employer-approved staff Google binding and required read/write/recording grants; controlled candidate inbox.",
      "Owned Google account", "Cancel dummy events and restore test-only roster/availability settings.", """
P0 | Project versus staff authorization | Inspect project connection > Attempt availability/invite before staff/employer binding > Complete authorized binding and retry | Project access alone grants no employer host authority; correct bound account is used afterward.
P0 | Approved invitation with verified Meet link | Prepare eligible dummy appointment > Approve event/invitation > Inspect provider and candidate link | Correct host/attendees/time; only a provider-confirmed usable Meet link is shown, not a pending conference placeholder.
P0 | Candidate cannot substitute another Meet link | Open candidate appointment link > Change job/schedule/candidate identifiers in approved negative test | Link retrieval stays candidate/appointment scoped; unrelated host link is not revealed.
P1 | Google panel availability intersection | Save approved panel roster > Compare available slots against each member's controlled conflicts > Change roster | Current member availability/versions are honored; no stale member or hidden calendar detail is used/disclosed.
P0 | Google event change and cancellation | Reschedule/cancel the managed dummy event > Repeat same request and inject uncertain response separately | Correct operation/receipt state and candidate view; no blind duplicate external event or false confirmed outcome.
P0 | Disconnect/reconnect during operation | Load eligible action > Revoke or change account binding > Submit stale action | Old account/revision cannot execute; recovery/stop does not create a new appointment.
""")

group("ZOM", "Zoom lifecycle and native links", "/coordinator; /settings/ats", "Original authorized Zoom host",
      "Valid owned Zoom OAuth configuration; managed dummy appointment; second unrelated host fixture.",
      "Owned Zoom account", "Cancel managed dummy meetings; retain unresolved receipts until reconciled.", """
P0 | Managed Zoom create | Approve dummy managed appointment > Create Zoom meeting once > Inspect original host and saved provider receipt | Exactly one correctly owned managed meeting; candidate receives only current usable join link.
P1 | Manual link is not managed receipt | Add supported manual dummy Zoom link > Open managed lifecycle/import controls | Manual provenance is clear and cannot masquerade as a provider-created owned meeting.
P0 | Zoom update and cancel | Reschedule then cancel managed dummy meeting > Verify provider/local states and candidate join visibility | Correct original host/operation is used; current links/status agree and stale links do not remain falsely confirmed.
P0 | Zoom unknown-operation recovery | In approved harness simulate accepted request with lost receipt > Trigger recovery only > Inspect provider creation count | Recovery reconciles existing operation; it never blindly creates another meeting.
P0 | Wrong account and invalid-client handling | Test invalid-client fixture/revoked grant without changing working credentials > Compare unrelated host attempt | Explicit safe setup/authorization error; no credential disclosure, account fallback or host impersonation.
""")

group("MED", "Human meeting recordings and reviewed notes", "Candidate/job Meeting Notes panel", "Authorized staff host/reviewer",
      "Disposable candidate/job, explicit participant consent, synthetic supported media, private storage; approved provider grants for native import cases.",
      "Private storage / AI processing; native provider for imports",
      "Delete disposable media via supported erasure/cleanup only; verify temporary file cleanup.", """
P0 | Explicit consent and manual upload | Open Meeting Notes > Attempt supported file upload without consent > Add explicit consent and upload | Missing consent is rejected; valid upload creates only a private unprocessed source note.
P1 | Inclusive upload byte bound | Engineering sends valid synthetic media at 104857600 bytes then 104857601 bytes through approved isolated harness | Exact 100 MiB bound is accepted when otherwise valid; +1 is rejected without storage leak or crash.
P1 | Decoded-duration bound | Process approved synthetic media just within and beyond 60 minutes > Inspect clear processing outcome | Supported duration succeeds; over-bound/invalid media is rejected honestly, not truncated and scored as complete.
P0 | Interrupted upload and temporary cleanup | Abort upload midway > Inject private-storage failure in isolated harness > Inspect permitted cleanup evidence | No orphan public object, lingering private temp bytes or false saved note; error is explicit.
P0 | Native Zoom recording identity | Preview/import one selected recording for the managed dummy appointment > Attempt foreign meeting/host/recording identifiers | Only exact authorized source imports; unrelated recordings remain inaccessible.
P0 | Native Meet recording identity | Confirm original Google account grants > Preview correct conference and recording > Attempt unrelated source | Correct provenance and host/appointment are enforced; no broad account recording browse/disclosure.
P0 | Duplicate source import | Import same selected native source twice or race two approved requests > Inspect notes/storage | One coherent source note or explicit reuse/conflict; no duplicate scoring or unmanaged stored media.
P1 | Browser capture and explicit upload | Use supported browser capture with consent > Stop > Review > Explicitly upload > Compare decoded audio tail | Capture, stop and upload are separate; saved media contains the intended complete source, not an empty UI success.
P0 | Transcript, question and speaker review | Process source > Review transcript/questions > Apply permitted source-bound anonymous speaker labels | Review preserves source/versions; anonymous labels are not claimed as real identity or an approved assessment.
P0 | Private evidence not automatically published | Save/process human notes > Inspect employer evaluation/Zoho/public/candidate results before disclosure approval | No automatic scoring, approved assessment or external publication is inferred from raw notes.
P0 | Media download authorization | Download as eligible reviewer > Repeat while anonymous, foreign employer and after account access loss | Authorized playable file only; unauthorized users get no usable media URL or bytes.
""")

group("REC", "Recall optional live attendance", "Candidate/job Meeting Notes → optional meeting capture", "Platform admin; original Zoom host; employer admin",
      "Managed approved dummy Zoom appointment; employer-authorized Recall workspace; consenting testers; signed callback configured and verified before live cases. Secret was added during handoff preparation, but runtime/callback delivery is unverified.",
      "Recall US West 2 / owned Zoom / signed lifecycle callback",
      "Stop and reconcile every bot; verify provider deletion and any imported local-note cleanup separately.", """
P0 | Workspace grant and explicit approval | Try host approval before employer grant > Platform admin authorizes correct workspace > Host records participant consent and approves appointment | Correct employer/host binding required; approval alone creates no bot and no capture.
P0 | Separate dispatch and visible silent identity | After setup/consent confirm Dispatch once > Host admits assistant to dummy meeting > Inspect name, notice and actual capture | One visible Lexy assistant captures approved audio only; no speaking, coaching, video or Recall transcription is enabled by this feature.
P0 | Missing/invalid webhook protection | Test isolated missing-config fixture > Submit unsigned, tampered and old callback requests > Compare valid signed synthetic delivery | Missing setup blocks dispatch; invalid callbacks fail; secret presence is not treated as actual callback-delivery evidence.
P0 | Simultaneous dispatch and unknown outcome | In approved harness race dispatch and simulate timeout/receipt loss > Refresh > Inspect writes and UI | Exactly one create claim/request; unknown state offers recovery, never automatic resend.
P0 | Bound receipt recovery | Recover unknown attempt with matching opaque metadata > Test zero/multiple/paginated/mismatched receipt fixtures | Only unambiguous exact receipt is adopted; ambiguity remains held without new bot creation.
P0 | Replayed and out-of-order lifecycle events | Send valid signed duplicate/late fixture events around recording/done > Inspect state | Replays dedupe and stale events cannot reopen terminal capture or change another attempt.
P0 | Stop scheduled versus active bot | Stop one future scheduled dummy bot > Stop one admitted recording bot > Observe final lifecycle and cleanup receipts | Scheduled delete and live leave-call are distinct; stop remains pending until appropriate end/media cleanup is confirmed.
P0 | Fatal upload is not premature deletion | In isolated provider harness send fatal/call-ended before final done > Request cleanup > Then deliver done | No full-media deletion claim while artifacts may still upload; final cleanup is confirmed before completion.
P0 | Revoke workspace or change appointment | Prepare/dispatch approved fixture > Revoke grant or change current host/account/appointment revision > Observe cleanup queue | New dispatch is blocked and existing capture receives durable stop/cleanup intent; no replacement bot is silently sent.
P0 | Reviewed private import | Complete consented capture > Select exact source > Review title/language/consent > Import > Inspect private note and provider cleanup | One private unprocessed note with provenance; provider cleanup requested; no automatic approved assessment or ATS publication.
P0 | Candidate erasure during capture | On disposable consented fixture request erasure with active/unknown recording receipt > Inspect held request and stop intent > Complete verified provider cleanup and retry | Erasure is not falsely complete; durable cleanup survives rollback; local and remote source cleanup are distinguished.
P0 | Access loss hides private cached state | Load attempts as host > Revoke test access/session while same page is open > Poll/retry | Cached recording detail/action controls disappear on denied fresh read; no stale dispatch/import can execute.
""")

group("ZOH", "Zoho Recruit overlay and applicant campaigns", "/settings/ats; imported job interview campaign", "Employer admin; assigned recruiter; independent approver",
      "Correct Zoho employer/data center, dummy job, dummy candidate AND associated application; approved scopes; controlled candidate inbox.",
      "Owned Zoho Recruit account", "Do not delete external records without owner approval; stop dummy campaign/notes attempts and retain receipts.", """
P0 | OAuth and employer confirmation | Connect through Lexy ATS settings > Complete sign-in > Inspect displayed company > Confirm correct employer | Correct employer-bound account; wrong-company/unconfirmed connection cannot import or contact applicants.
P0 | Reviewed preview/import | Preview dummy job and associated applicant > Select only reviewed records > Import to development > Repeat import | Correct job/candidate/application linkage with provenance and dedupe; no broad unreviewed intake or outbound contact.
P0 | Application identity is not job/candidate ID | Test dummy association using actual application identity > Supply job ID/candidate ID in the application field in isolated negative test | Wrong identity is rejected; results/contact cannot be attached to another application.
P0 | Imported draft submission and approval | Open imported draft > Author submits > Different eligible reviewer approves > Open campaign preview | Draft is not silently approved; eligible campaign only after attributable current approval.
P0 | Applicant selection and one approved invitation | Preview job-associated applicants > Select one consenting dummy recipient and valid plan > Explicitly approve/send > Reclick/refresh | Exactly intended applicant receives one interview invitation; no unrelated bulk contact or invented sourcing-interest step.
P0 | Interview completion to human review | Complete received dummy interview > Open current results in imported job context > Record eligible human evaluation/decision | Correct applicant/job evidence and attributable decision; no automatic remote stage advancement.
P0 | Approved progress/assessment note publication | With employer write permission review exact publication and application > Approve disclosure/version > Publish one allowed test note > Read Zoho | Only intended progress/approved assessment material appears with receipt; private development/unapproved source notes stay excluded.
P0 | Stale or revoked publication | Change application/binding/evidence revision or revoke write grant after opening publication > Submit stale action | Old approval/account cannot publish; uncertain outcome is held and not blindly repeated.
P0 | Remote stage advancement is not falsely claimed | Configure local stage mapping/simulated handoff > Inspect local and actual Zoho application status | UI/export/simulation is not represented as a remote write; live writer remains explicitly unfinished.
P0 | Local stage request has no remote effect | On a reviewed dummy applicant prepare one stage request after metadata review > Reload > Inspect saved request and actual Zoho stage | Request/history persist, application stays unchanged, and no candidate contact or live execution is claimed.
P0 | Stage approval is explicit and snapshot-bound | Inspect the exact pending dummy request > Acknowledge and approve locally > Reload > Compare request revision and Zoho stage | Only the reviewed revision is locally approved; approval sends nothing, schedules no later send, and cannot become permission for changed evidence.
P0 | Changed stage evidence invalidates old approval | Prepare a dummy request > Have the authorized reviewer change its human decision or mapping > Try the old request action | Stale action is rejected and refreshed evidence requires new review; no remote update or automatic retry occurs.
P0 | Local stage request can be withdrawn | Prepare a fresh dummy request > Withdraw it with the expected revision > Reload history | Withdrawal remains attributable and durable; a stale approval cannot revive or execute the withdrawn request.
P0 | Stage recovery is observation only | With an isolated uncertain-attempt fixture authorized by the test owner inspect recovery before and after an observed target match | The result is an observation, not attributable verified delivery; no resend is unlocked and revoked access hides protected data.
P1 | Scheduled refresh and disconnect | Opt into approved read-only refresh > Change dummy record externally > Refresh > Disconnect locally | Read refresh is scoped/auditable; disconnect blocks future use without deleting external records.
""")

group("ATS", "Greenhouse foundation and ATS handoff", "/settings/ats", "Platform admin; separate exact-employer admin",
      "Optional owned Greenhouse test account and explicitly allocated connection; no production/real-candidate writes.",
      "Owned ATS account; mark Blocked if unavailable",
      "Disconnect only the local dummy binding with approval; do not revoke unrelated grants.", """
P0 | Two-party employer allocation | Platform admin allocates approved test account to employer > Same actor/agency admin attempts confirmation > Exact employer admin confirms | Ownership confirmation requires correct independent employer actor; project connection is not customer authority.
P0 | Read-only verification and preview | Verify active confirmed binding > Preview approved dummy job/profile metadata > Inspect requests and history | Scoped read-only account operations; verification history is dated and not permanent health or full two-way sync.
P0 | Foreign connection and disconnected binding | Substitute foreign employer/account/job identifiers > Disconnect locally > Retry stale preview/refresh | Foreign/disconnected access is denied; no external deletion or automatic reallocation occurs.
P1 | Approved metadata/profile intake | Preview explicitly selected metadata/profile > Confirm intake > Repeat/refresh | Only reviewed scoped source data persists with provenance; no surprise contact or duplicate global profile.
P0 | External offer/stage ownership handoff | Select employer-declared external ownership > Review handoff/export outcome > Inspect actual external status | Local handoff is labelled accurately; no unsupported ATS stage or offer writer is claimed.
""")

group("OFF", "Human-controlled offers and outcome ownership", "/jobs/:id; employer offer review surface", "Eligible employer owner; independent human reviewer; dummy candidate",
      "Authorized hiring decision; employer-owned synthetic offer; controlled inbox; explicit approval before any test send.",
      "Controlled email delivery for send cases", "Withdraw/expire only test offers through supported flow; retain audit/receipt history.", """
P0 | No autonomous offer issuance | Reach positive AI recommendation without authorized offer approval > Try downstream send path | AI result cannot issue/negotiate/send final offer or bypass employer authority.
P0 | Employer owner versus agency recruiter | Prepare offer as approved employer owner > Repeat ownership claim/action as agency-only recruiter | Employer-owned authority is explicit; recruiter membership alone does not grant HR/offer issuance power.
P0 | Terms edit invalidates approval | Approve synthetic offer version > Edit material terms > Try send using stale approval > Reapprove current version | Old approval cannot authorize modified terms; fresh human approval is required.
P0 | One human-approved test delivery | Review exact current version/recipient > Approve/send one synthetic offer > Refresh/retry > Verify provider and inbox | One controlled send with attempt-bound receipt; no duplicate or stale-version delivery.
P0 | Delivery uncertainty and ownership recovery | Simulate accepted/lost receipt or owner change in development harness > Use recovery/review | Uncertain send is held, current owner/version authority is rechecked, and no automatic resend or owner impersonation occurs.
P0 | Candidate response does not create employment/fee | Candidate accepts/declines dummy offer > Replay response > Inspect outcome and fee ledger | Atomic eligible response; no automatic employment, identity proof or unsupported fee trigger.
P1 | External HR handoff and notifications | Configure external employer ownership > Review handoff and eligible owner/reviewer notifications | Correct employer receives review/recovery notice; Lexy does not imply an unimplemented external offer execution.
""")

group("POR", "Candidate portal, privacy and role alerts", "/portal; /portal/settings", "Two candidate testers; employer staff",
      "Two independent dummy candidate identities with different applications and privacy settings.",
      "Development app; controlled inbox for alert cases",
      "Remove test subscriptions and candidate fixtures through approved process.", """
P0 | Own profile/application boundaries | Candidate A edits own profile/applications > Replay candidate B identifiers and API reads | Own allowed changes persist; no foreign profile, application or private child-row access.
P0 | Employer interview versus practice results | Compare candidate's own baseline/mock result and employer-requested interview | Candidate sees only permitted own development results, not confidential employer evaluation.
P0 | Private prep/career material not recruiter evidence | Create private prep/career notes > Inspect employer profile/export/intelligence and scoring inputs | Private development is excluded; separate candidate-approved narrative is not confused with raw private material.
P0 | Discovery pause and historical viewer privacy | Enable viewer-history fixture > Pause discovery/change privacy > Reopen historical viewer list | Current privacy settings suppress disallowed historical visibility; paused view remains quiet.
P0 | Confidential or unapproved job alert exclusion | Candidate follows company > Prepare confidential/unapproved job > Trigger controlled alert preview/send eligibility | Candidate interest is not employer publication consent; restricted roles remain undisclosed.
P1 | Quiet email versus subscription withdrawal | Enable alert > Set quiet email > Withdraw subscription > Inspect email eligibility and saved subscription state | Email suppression and withdrawal have distinct correct effects; no automatic resubscription.
P1 | Portal navigation and session recovery | Navigate applications/interviews/prep/settings at mobile width > Refresh > Sign out and back in | Correct self context persists; no broken navigation, stale other-user data or missing required control.
""")

group("LRN", "Private learning, assessments and voice progress", "/portal/learning-growth", "Candidate A and B",
      "Disposable learning-enabled candidates, available pilot course/catalog and baseline evidence; no employer hiring decision depends on this data.",
      "Configured learning/assessment providers where used",
      "Keep development evidence private; remove only disposable learning records via approved erasure.", """
P1 | Learning catalog and course progress | Open available course > Complete valid lesson/exercise > Refresh/reopen | Correct candidate course/progress persists; incomplete content is not marked complete.
P0 | Learning owner access not just tenant | Candidate A opens own course/assessment/voice history > Replay candidate B record IDs in same tenant | Owner-level authorization denies foreign private learning data even within same tenant.
P1 | Verified completion rewards once | Complete qualifying learning event > Retry/replay completion > Inspect private badge/credit history | One qualifying award at verified completion; no money, duplicate reward or employer score claim.
P1 | Baseline versus reassessment evidence | Record baseline > Complete required training > Reassess using supported like-for-like path | New evidence and required training are respected; improvement is not inferred from incomparable/duplicated evidence.
P1 | Voice progress cycle and recovery | Start permitted voice practice cycle > Complete evidence > Refresh/reopen report > Retry completed step | Correct candidate cycle/evidence persists; retries do not invent progress or duplicate completion.
P0 | Learning firewall across hiring surfaces | Update only private learning results/rewards > Compare employer scoring, exports, alerts and ATS publication | Private learning is not serialized/scored/published as employer hiring evidence.
P1 | Development score framing | Inspect low/null/better-progress candidate fixtures > Review percentile and next-action copy | Constructive truthful framing; missing evidence is not a low score and unsupported percentile/improvement is not invented.
""")

group("OPS", "Analytics, runs, notifications and economics", "/analytics; /runs/:id; /notifications", "Assigned staff; platform operations",
      "Dummy job with known eligible/terminal/DNC cases and known run events; no changes to live billing or rates.",
      "Development app", "Stop dummy runs and test notifications; retain non-PII receipts for triage.", """
P1 | Counts reconcile with linked lists | Record dashboard/digest/job analytics counts > Open linked filtered lists > Compare same tenant/job/privacy state | Counts and doors share scope/filter semantics; DNC/erased candidates do not reappear as hidden counts.
P1 | Terminal stages and manual placement | Move approved dummy candidate via supported manual/no-automation path > Inspect active board/closed drawer/analytics | Correct terminal display and stage history; manual move does not silently send messages or run agents.
P0 | Run progress and resume without duplication | Start bounded approved run > Inspect ordered events > Refresh/restart recovery in isolated environment | Durable unique progress and correct terminal status; recovery does not repeat claimed provider actions.
P0 | Pause stops new actions without fake reversal | Pause eligible dummy run/campaign with pending work > Inspect later actions and already delivered receipts | Pending/new execution is blocked; already sent messages are not misrepresented as undone.
P1 | Scoped notifications and stale success message | Trigger eligible review/reply/schedule notification > Change ownership/access > Reopen | Only eligible recipient sees current scoped detail; prior success/authority notice does not outlive permission.
P0 | Complimentary full-feature pilot | Admin creates/redeems authorized complimentary pilot code > Check included Enterprise features and bill/payment surfaces | Intended free internal access works without Lexy payment activation; authorization/privacy gates remain and no unwanted charge occurs.
P1 | Usage costs remain unknown without bills | Execute approved bounded dummy provider operation > Inspect usage observation/report | Receipt units/activity are attributed where known; unknown cost is not zero, fabricated tariff or customer bill.
P0 | No private payloads in observability | Review sanitized logs/usage report after tests with known dummy text > Search permitted diagnostics for sensitive payload classes | No credentials, auth cookies, transcript/resume bodies or secret-bearing links in general usage/defect telemetry.
""")

group("SEC", "Privacy, exports, erasure and recovery", "Privacy/export/deletion surfaces", "Candidate; authorized privacy admin; foreign staff",
      "Dedicated disposable fixtures with provider and file cleanup owner; explicit approval for destructive/security tests.",
      "Private storage / provider cleanup for media cases",
      "Verify actual fixture erasure/export access and remove downloaded sensitive test exports securely.", """
P0 | Candidate data export ownership | Candidate requests own export > Inspect allowed contents > Try other candidate and anonymous download | Correct owned export only; confidential employer/foreign/private data outside allowed scope is excluded.
P0 | Erasure across linked data and files | On approved disposable candidate request/fulfill erasure > Inspect authorized downstream profile, queue, ATS links and storage evidence | Correct account/data/media scope is removed or honestly held; foreign/staff/shared identities are not accidentally closed.
P0 | Late write after erasure fence | In isolated harness pause background candidate write > Complete permitted erasure/fence > Release late write | Rejected late write cannot recreate private candidate data; no rejected payload is copied into logs.
P0 | Indirect ATS identity fence | Erase dummy canonical/linked identity > Attempt import/refresh from associated external identity in approved harness | Indirect provider observations/identities cannot restore erased personal data.
P0 | DNC/erasure list-count-download parity | Set controlled exclusion on disposable candidate > Check list, count, search, analytics, export and direct downloads | Consistent eligibility/privacy enforcement across every tested surface, not just row-field masking.
P0 | Role change and cached read failure | Load private staff/meeting data > Return denied fresh read in approved session test > Try old actions | No stale cached private content or formerly privileged action remains available.
P0 | Offer/share public token scope | Open approved dummy hiring-manager share/offer token > Alter candidate/resume/version identifiers > Repeat expired token | Snapshot/token scope and expiry enforced; résumé is bound to allowed snapshot and no broad data access is gained.
P0 | Malicious file and stored prompt reference | In isolated supported upload/plan harness use harmless wrong-type file and untrusted instruction text in dummy job/resume | Unsupported media rejected safely; reference text cannot override authorization, scoring/privacy rules or configured model policy.
""")

group("REL", "Environment, reliability and release", "IT operator checklist; development runtime", "IT release owner; engineering; cloud owner",
      "Approved isolated targets, rollback owner, backups for any destructive step, intended concurrency agreed in advance.",
      "IT-owned environment and provider/cloud accounts",
      "Restore isolated environment; no production command or mass send is authorized by this case.", """
P0 | Correct environment and action-link origins | Record exact development app/API/database identities via authorized tools > Inspect delivered interview/booking/offer links | Every action targets its owning environment; external production is not inferred from development URL.
P0 | Schema and private-storage readiness | Operator compares actual target schema/security to reviewed migration plan through 0112 > Verify private tags/encryption/ACL and a dummy authorized download | Required constraints/triggers/RLS exist on selected target; source filenames alone are not accepted as rollout evidence.
P0 | Exact-build combined regression | Engineering runs approved complete baseline once on the acceptance build > Retain final summary/build/time | Completed final result is reported accurately; no old, partial, timed-out or pre-attendance result is called a new full pass.
P1 | Controlled upload concurrency and disk headroom | Agree isolated load level > Run bounded parallel synthetic uploads and aborts > Observe memory, temp disk, errors and cleanup | Measured result meets owner-approved SLO at stated load; no crash/leak or unsupported production capacity claim.
P0 | Runtime restart and external-action recovery | In isolated deployment with dummy pending work restart once > Inspect workers/queues/receipts > Reopen affected UI | Existing claims reconcile; no duplicate emails/meetings/bots and no silent completed-work loss.
P0 | Provider outage and safe recovery | Use development fault harness for storage/AI/calendar/ATS unavailable conditions > Restore service > Retry documented recovery | Explicit bounded failure/uncertainty, no fabricated success, authorization bypass, uncontrolled retries or silent fallback-model change.
P0 | Release sign-off and rollback ownership | Review open P0/P1 defects, blocked live tests, schema/provider evidence and release scope > Assign rollback/incident owners > Obtain actual sign-off | No automated workbook count grants release; unresolved required blockers and build gaps are explicitly dispositioned.
""")

group("E2E", "End-to-end acceptance journeys", "Multiple linked UI surfaces", "Named cross-functional test team",
      "Same labelled dummy job/application/candidate throughout each journey; real independent approver; all listed provider/contact/recording consent prerequisites met.",
      "Controlled live providers and human testers as selected",
      "Reconcile all messages, meetings, bots, offers and media; do not erase evidence before triage.", """
P0 | Native AI interview journey | Submit/independently approve job > Admit/screen/verify dummy candidate > Approve engagement > Record Interested/review > Invite/complete AI interview > Review evaluation > Record human hiring decision | One continuous attributable native journey with current evidence and no duplicate/unauthorized external action.
P0 | Zoho applicant overlay journey | Connect/confirm employer > Preview/import associated dummy applicant > Submit/approve job/plan > Select/approve one applicant invite > Complete interview > Human review > Approved allowed progress/assessment publication | Exact external application stays linked; intended interview/result/note lifecycle works; remote stage advancement is not falsely claimed.
P0 | Human interview calendar journey | Approve dummy interview > Offer restricted slots > Candidate books > Host/provider confirms > Reschedule then cancel in supported sequence | Calendar privacy, current host/version, candidate links, provider states and notifications remain coherent end to end.
P0 | Human recording evidence journey | Conduct consented dummy meeting > Import/upload exact source > Process > Review transcript/questions/speakers > Approve only permitted assessment/disclosure | Private source, reviewed evidence and approved publication remain distinct; no invented speaker identity or automatic hiring decision.
P0 | Recall capture journey | Configure/verify signed callback and employer grant > Original host approves/dispatches > Admit visible silent bot > Finish > Verify signed done > Review/import > Verify remote cleanup | Genuine live attendance and private import/cleanup have attributable evidence; mock results are not substituted.
P0 | Human-owned controlled offer journey | Complete authorized hiring decision > Employer owner prepares version > Human reviewer approves > Send one synthetic offer > Candidate responds > Inspect outcome | Approval/version/owner/receipt boundaries hold; no automatic negotiation, employment record or unsupported fee event.
P0 | Candidate private-development journey | Register > Create private career/prep evidence > Complete course/practice/reassessment > Change privacy > Inspect employer scoring/export/ATS | Candidate development works without leaking private content into employer hiring or external publication.
P0 | Consent/access revocation across flow | Begin a consented dummy appointment/interview/capture > Revoke eligible consent/access or erase approved disposable candidate > Release queued/delayed work > Reconcile cleanup | New unauthorized operations stop, late private writes are fenced, provider outcomes stay honest and no shared/staff data is wrongly erased.
""")

# One reproducible execution row per configured language. Catalog metadata is
# an advertised capability, not evidence of actual runtime provider selection.
ai = (Path(__file__).resolve().parents[2] / "artifacts/api-server/src/lib/ai.ts").read_text()
catalog = ai.split("export const SUPPORTED_LANGUAGES:", 1)[1].split("\n};", 1)[0]
LANGUAGES = []
for code, label in re.findall(r'^  "?([a-z]{2,3}(?:-[A-Z]{2})?)"?: \{\s+label: "([^"]+)"', catalog, re.M):
    if code not in {row["code"] for row in LANGUAGES}:
        LANGUAGES.append({"code": code, "label": label})
assert LANGUAGES, "Configured language catalog could not be extracted; do not invent it."
group("LNG", "Configured interview-language acceptance", "/interviews; /interviews/:id/room",
      "Fluent consenting language reviewer; recruiter",
      "Approved fresh dummy interview for this exact locale; fluent reviewer; controlled device/audio; existing configured models/routing unchanged. Confirm locale is offered to this tenant before running.",
      "Configured AI/speech providers; fluent reviewer",
      "Keep consented source audio private; record observed route without secret/provider-payload disclosure.",
      "\n".join(
          f"P1 | Language acceptance: {l['label']} ({l['code']}) | Select {l['code']} on approved fresh plan/session > Hear introduction and question > Give short, long and unknown-skill responses in this language > Refresh/resume and finish > Fluent reviewer compares source audio, saved answers and evaluation; record observed STT/TTS/LLM route | Correct persisted locale, intelligible speech, faithful capture and bounded adaptation/recovery; no unsupported translation/model switch or fabricated language competence. If locale unavailable or reviewer/provider missing, record Blocked with reason, not Pass."
          for l in LANGUAGES))

SMOKE_IDS = [
    "ACC-01", "ACC-02", "ACC-04", "WKO-01", "WKO-02", "WKO-03", "WKO-04",
    "CAN-01", "CAN-03", "ENG-02", "ENG-03", "INT-01", "INT-02", "INT-04",
    "INT-08", "INT-11", "INT-12", "EVA-02", "EVA-05", "CAL-01",
    "CAL-03", "ZOH-02", "ZOH-05", "OFF-01", "OFF-03", "REC-01",
    "REC-03", "SEC-06", "REL-01",
]
group("GHC", "Greenhouse reviewed interviews and note publication", "/settings/ats → job workflow", "Employer admin, independent job approver, candidate tester",
      "Owned Greenhouse test employer, correct permissions, one dummy linked applicant, approved work order and nonempty frozen plan; controlled inbox.",
      "Authorized Greenhouse test account", "Retain sanitized receipts; do not resend unknown attempts or change real applicants.", """
P0 | Employer-bound direct connection | Connect the owned test employer > Confirm the displayed employer > Open the same page as another employer | Only the intended employer can use the connection; another tenant cannot read private state or operate it.
P0 | Reviewed applicant identity binding | Preview one dummy job/application > Review and import/link the canonical applicant > Reopen the workflow | Job, application and candidate remain correctly bound; import is not an invitation or stage advancement.
P0 | Prepare is not send | Select one linked applicant and a nonempty saved plan > Prepare preview > Reload | Recipient and message can be reviewed; no email has been sent.
P0 | Exact approved deliberate invitation | Approve the exact preview > Deliberately run once using the controlled inbox > Reload and repeat the action | Correct invitation goes to the approved recipient; a replay does not generate another invitation; acceptance is not delivery.
P0 | Stale or uncertain batch recovery | Invalidate the approved snapshot or revoke authority before execution > Test an injected uncertain result in an isolated fixture | Stale approval cannot send; uncertain execution is held for evidence review rather than blindly repeated.
P0 | Progress note approval and visibility | Preview progress > Approve the exact content > Publish once > Verify the note in Greenhouse > Reload/replay | Preview never publishes; note targets the exact applicant with intended admin visibility and does not duplicate.
P0 | Assessment disclosure is separate | Complete the dummy interview > Review locally > Preview assessment > Separately approve publication | Local review alone does not publish; only the approved assessment is disclosed, with no private career/learning data.
""")
group("MAIL", "Scheduled email reservations and truthful outcomes", "Approved development fixtures / controlled test inbox", "Developer and security reviewer",
      "Isolated synthetic profiles, mocked transport and fault injection first; explicit authorization before any owned inbox send.",
      "Mocked development fixture; live inbox only by approval", "Remove synthetic fixtures; never reset ambiguous claims merely to force another email.", """
P0 | Shared job-change reservation | Start self-report and status-check-in sends concurrently for one synthetic candidate > Release the mocked provider response | Only one eligible follow-up reaches transport; both paths share cooldown and unknown holds.
P0 | Canonical sync through uncertainty | Inject uncertain job-change send > Save a subsequent legitimate profile change | Profile sync succeeds while another email remains held; pending is not relabelled failed or delivered.
P0 | Weekly digest six-day compatibility | Seed a recent historical digest timestamp > Run a synthetic digest tick > Advance fixture time past six days | Recent stamp suppresses duplicate; an eligible future cycle remains possible without changing reminder policy.
P0 | Accepted weekly mail with failed stamp write | Accept mocked mail > Fail legacy timestamp persistence > Run a second eligible tick | Durable receipt prevents another send despite missing timestamp; outcome is not proof of delivery.
P0 | Simulation and suppression are not sent | Inject simulated and suppressed results for digest, status check-in and post-hire pulse | No accepted-mail count or success notification is invented; no cadence receipt claims real delivery.
P0 | Post-hire claims and unknown outcomes | Run two synthetic ticks for one 30-day pulse > Inject timeout/unknown > Repeat the tick | One claimed attempt reaches transport with SDK retry disabled; claim remains consumed and is not automatic delivery evidence.
P0 | Fresh privacy and owner checks | Change canonical owner, recipient, pool, DNC or erasure between selection and reservation | Stale or disallowed contact does not reach transport; no cross-owner contact or erased-profile rewrite.
P1 | Default-on status check-in and explicit opt-out | Inspect the startup fixture with unset, true and false opt-out values | Existing default-on behavior remains; explicit false stops scheduling; no external lookup runs in the fixture.
P0 | Recover missed private weekly recap | Accept a mocked weekly email > Fail notification persistence > Run scoped recap recovery | One private bell entry is restored without another email; the accepted receipt still enforces cadence.
P0 | Historical recovery is honest | Recover an older accepted bound receipt after current learning metrics have changed | Recap uses its original reporting date and generic recovery copy; no current progress is presented as historical.
P0 | Recovery identity and receipt fences | Change account binding, email, tenant, pool, DNC or erasure > Try recovery of pending and legacy receipts | Ineligible receipts do not create notifications; delivered/opened receipts with original acceptance remain eligible; read state is preserved.
""")
group("HOLD", "Metadata-only email hold review", "/platform/mail-holds", "Platform administrator / security reviewer",
      "Synthetic reserved-email fixtures only. This UI cannot send or release mail.", "Development API and platform-admin test identity",
      "Delete only owned synthetic fixtures and their audit entries; do not release real holds.", """
P0 | Admin-only discovery and metadata | Open Mail Holds from the platform-admin sidebar > Repeat GET and POST as candidate, recruiter, tenant admin, suspended and signed-out users | Only an active platform admin can read/review; no recipient address, name, subject or message body appears.
P0 | Explicit valid review | Select a hold > Try blank decision, malformed reference, missing acknowledgement and extra status fields > Submit a valid ticket reference and decision | Invalid input is rejected; booleans must be literal true; no caller can set sent/failed/delivered state.
P0 | Close without resend | Close a synthetic review > Reload > Attempt the same cadence through mocked transport | Review and actor are audited; original pending hold and null send time remain; no email is retried and the same cadence remains blocked.
P0 | Concurrent and stale reviews | Two administrators review the same version > Finish sender bookkeeping before a stale review | One review wins; stale versions return conflict or unavailable; existing provider outcomes are not overwritten.
P0 | Audit failure or lost response | Fail audit persistence or interrupt the review response > Reload before retry | No false success; send hold is unchanged; persisted decisions can be inspected after refresh; stale replay does not append a duplicate.
P0 | Cached data after denial | Load a queue page and selection > Revoke access or inject 401/403 on read/review > Retry > Restore with fresh authorized read | Rows, selection and success details are hidden during denial; old review form is not resurrected; no cached page authorizes submission.
P0 | Fresh erasure and ownership fences | Change DNC, erasure or tenant ownership before review > Try a non-email or unrelated ledger entry | Review/list exclude ineligible records; operator action never sends or writes a new delivery outcome.
P1 | Bounded cursor and narrow scope | Load more than 50 owned fixtures > Navigate next/back > Review and refresh > Check mobile layout | Pages are bounded and reset after review; closed-review status survives reload; offer, erasure, post-hire and outreach-specific ledgers are not represented as covered.
""")
SMOKE_IDS += ["GHC-03", "MAIL-05", "MAIL-09", "HOLD-01"]
group("SRH", "Session revocation, manual HR handoff and bounded contention", "/login and job ATS handoff",
      "IT security reviewer and designated employer offer owner",
      "Use authorized dummy identities and two independent browser sessions; migration 0113 applied to the test identity/control database; never record credentials.",
      "Development app", "Sign out fixture sessions; use exact fixture cleanup; retain only sanitized results.", """
P0 | Copied cookie rejected after logout | Sign in using a dummy account > Capture credential only in test memory > Log out > Replay credential against protected read and review | Server denies replay; no private response or review write.
P0 | Copied bearer cannot bypass logout | Repeat logout replay using Authorization rather than Cookie | Same revoked session is denied before route authorization.
P0 | Another login survives | Log into two independent profiles as the same dummy user > Log out profile one > Use profile two | Second login remains authorized; logout is session-specific.
P0 | Logout failure is honest and retryable | Use isolated browser harness to simulate logout 503 > Retry with 200 | Error is visible; local credentials are retained until confirmation; confirmed retry clears credentials and redirects.
P0 | Revocation lookup fails closed | Run isolated revocation-guard lookup-failure test without changing a shared database | Signed session receives 503 rather than access; missing migration is not bypassed.
P0 | Manual handoff prerequisites | As owner try record before approval or export > Supply a URL or no acknowledgement | Action is blocked; no ATS call, offer, employment or fee event.
P0 | Record exact employer handoff | Approve and export dummy packet > Enter safe case reference and deliberate acknowledgement > Record > Refresh | Actor, time and reference persist as human-reported only; no verified ATS delivery is claimed.
P0 | Handoff loses authority or freshness | Remove fixture owner authority or change source evidence > Try prior packet > Prepare fresh packet | Old action denied; form intent resets; new packet does not inherit prior receipt.
P0 | Handoff replay remains local and idempotent | Replay exact request with same revision and key > Try a different acknowledgement of recorded packet | Exact replay does not duplicate; another acknowledgement is rejected; original history retained.
P1 | Bounded queue contention and interrupted recovery | Run isolated campaign test with injected providers > Inspect 16 recipients and eight workers > Replay empty queue > Inspect interrupted attempt | Exactly 16 synthetic attempts and sessions; no resend on empty retry; uncertain attempt remains held; metrics are not production capacity.
""")
SMOKE_IDS += ["SRH-01", "SRH-03", "SRH-07"]
group("CRE", "Credential epoch and replica restart security", "/login and /portal/reset-password",
      "IT security reviewer",
      "Use isolated dummy accounts, a verified development fingerprint and migrations 0113/0114; do not use a real password/reset link.",
      "Development app", "Use journal-owned cleanup; retain no credentials in screenshots, logs or reports.", """
P0 | Password reset invalidates older sessions | Sign in twice as one dummy account > Complete a valid reset > Replay both prior credentials using cookie and bearer | Prior sessions denied; reset-issued session and new-password login succeed; old password fails.
P0 | Candidate reset uses current epoch | Use candidate-specific login after a password change > Reset again > Try old candidate session and fresh candidate login | Older candidate session denied; new cookie and candidate login work.
P0 | Cross-process logout remains session-specific | Run the fingerprint-guarded session-replicas check > Log out on A > Replay on B > Check another same-account login | Copied credential denied on both processes; independent login remains valid.
P0 | Restart proof retains a valid control | Replace B while retaining revoked and valid credentials in test memory > Retry both on the replacement | Revoked token stays denied and valid control succeeds; failure is not caused by signing-key loss.
P0 | Same-second and hash-restoration resistance | Use isolated identical-issuance-second tokens > Change hash > Restore an earlier hash > Try restoring epoch directly | Only current epoch works; hash or epoch rollback cannot revive an earlier signed session.
P0 | Profile edit and unrelated account remain valid | Update a name or unchanged hash > Use another dummy account during resets | No unintended epoch rotation or cross-account revocation.
""")
SMOKE_IDS += ["CRE-01", "CRE-03", "CRE-04"]
group("DEV", "All-device sign-out", "Settings / Account Settings", "Staff and candidate",
      "Use two sessions of one dummy account plus a separate dummy control account; reviewed migrations 0113/0114/0115 applied in development.",
      "Development app; organization-only case needs an authorized SSO-only fixture",
      "Sign in again with the unchanged password; use exact owned-fixture cleanup; never record credentials.", """
P0 | Staff ends all account sessions | Open staff Settings > Enter current password > Acknowledge every device > Submit > Replay both older sessions | Both denied; unrelated account works; password unchanged; fresh login succeeds.
P0 | Candidate ends only their own account sessions | Repeat from candidate Account Settings with two owned sessions | Both candidate sessions denied; other identities remain authorized.
P0 | Missing confirmation cannot revoke sessions | Submit with missing password or missing acknowledgement | No action; button disabled or API 400; no audit or epoch mutation.
P0 | Wrong password remains retryable | Submit an incorrect password > Observe message > Retry correctly | Wrong attempt preserves session and clears password/acknowledgement; valid retry succeeds; repeated attempts are throttled.
P0 | SSO-only accounts have no bypass | Use an authorized organization-only dummy account > Attempt password confirmation | Explicit unsupported-confirmation response; no invalidation or false success.
P0 | Audit failure rolls back the action | Run the isolated real-SQL audit-failure fixture | Original epoch and both valid sessions survive; no success audit.
P0 | All-device sign-out survives restart | Run native replica fixture > Rotate through endpoint > Replace API process > Replay older sessions and valid control | Old credentials remain denied; unrelated account and fresh login work.
P0 | Account switch clears pending confirmation | Begin fixture sign-out > Switch identity before delayed response | Password/acknowledgement cleared; delayed response does not sign out the new identity.
""")
SMOKE_IDS += ["DEV-01", "DEV-02", "DEV-03", "DEV-07"]
assert len({c["id"] for c in CASES}) == len(CASES)
assert set(SMOKE_IDS) <= {c["id"] for c in CASES}
