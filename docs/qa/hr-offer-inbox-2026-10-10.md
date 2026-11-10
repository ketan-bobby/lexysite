# Employer offer review inbox

## Implemented

- `/offer-inbox`, with sidebar navigation for employer staff roles that may be explicitly designated.
- Assigned work only, not an organisation-wide financial directory. Active caller, owning employer tenant, explicit designation, requisition ceiling, application linkage and current candidate hard-exclusion/privacy seals all apply.
- Owner, approver, sender and external-contact views. Platform administrators, candidates and interviewers cannot enter this inbox; agency membership and general employer administrator status do not include unassigned offers.
- Cursor pagination, loaded-row search/filter labels, manual refresh, and finite polling of every loaded page and selected detail.
- Reloadable selected-offer links, removal/reassignment handling, original human hiring reasons and recorded evidence, identity/synthetic/stale-decision/delivery/expiry caveats.
- Existing native financial controls reused: draft/review submission, exact-version approval and a separate human send confirmation. No automated offer sending.
- External handoff stays manual and disconnected. Native financial controls are absent; evidence packet download remains available.
- Offer acceptance is not employment, identity clearance or a fee trigger. No model/provider/rubric or older Linx data changes.

## Checks

- Focused controlled-offer HTTP suite: **8 tests passed**, including new assignment/privacy/reassignment/pagination/expiry cases and existing approval, correction, delivery and response regressions.
- Frontend typecheck passed after generated shared declarations were rebuilt.
- Targeted new-route lint and route-ownership guard passed. Existing guard baseline exceptions were not expanded.
- Full backend typecheck was attempted with a bounded runtime but did not finish; this is not a claim that the existing whole backend typecheck is clean.
- Browser verification uses isolated fictional staff and two synthetic applications only. It must approve only a synthetic version, cancel the final send confirmation, and close all testing contexts afterward.
- Browser pass completed: unassigned administrator empty/hidden detail; owner draft/review submission without approve/send; approver exact-version approval; sender separate confirmation canceled, approved offer unsent; external packet/evidence and reloadable selection; 390px close/list/navigation without horizontal overflow. The helper closed its only context/page.
- Intermittent unrelated 403 resource responses did not block the tested flows. The browser could confirm hidden admin detail, not conclusively attribute a specific 404 request; the authenticated HTTP tests independently assert that detail's 404.
- Final persisted-state/API check passed: approved native offer unsent, manual external contact without approval/send authority, original evidence retained, no employment/outcomes/fees. Fictional staff were suspended and temporary session data removed afterward.

## Not included

- Greenhouse connectivity or ATS synchronisation.
- Staff-departure ownership recovery; existing active-offer assignment locks remain fail-closed.
- Automatic candidate email, staff email notifications, new interviews, provider requests, new assessments, legal approval or employment/fee creation.
