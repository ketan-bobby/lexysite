# Employer-owned offer controls

## Implemented boundary

- Explicit employer owner, approver and sender assignments; a general recruiting or platform role is not offer authority.
- Only the requisition's owning-employer tenant administrator may configure assignments. Active assignees must belong to that employer and be eligible to access the requisition.
- Native terms/review submission, approval, send and withdrawal have separate server capabilities and UI controls. Approval does not automatically send.
- External ownership disables native offer mutations. The external system/application link is a manual handoff, not a live ATS connector.
- After a current human Hire decision, external ownership displays Awaiting employer. Hold/decline pauses handoff; stale or unapproved requisitions cannot claim a current offer-ready handoff.
- A downloadable decision/evidence summary preserves human reasons and original workflow notes, with synthetic and no-employment/identity-clearance caveats.
- Job-serialized configuration prevents a second workflow from creating a competing offer process for the same candidate/application.
- Structured human decisions and configured ownership also block legacy offer-extension/acceptance fee shortcuts, even before a native offer record exists.
- Configuration, written reasons, actor, revision and ownership history are retained. Existing active offers cannot be silently moved to an external process.
- Explicit initial adoption of a legacy native offer preserves delivered terms/responses. Unsent legacy approvals reset for fresh review; in-flight sends cannot be adopted.

## Verification

- Focused HTTP group: 7 tests passed, including role separation, employer-versus-agency scope, invalid assignees, native/external exclusion, competing workflows, safe links, legacy adoption, exact-version approval, idempotency, correction history, recipient responses and no employment/fee side effects.
- Generated shared packages and frontend typecheck passed.
- Initial changed-file lint passed. Backend-wide typecheck still has 520 existing errors; no diagnostics were reported in the new ownership/control libraries or routes.
- Managed API build and existing ownership/privacy/rubric guards passed; frontend and API restarted successfully.
- Browser verification uses a separate isolated employer/agency fixture with two distinct synthetic applications and no interview creation. No candidate email/send is authorised in this pass.
- The focused desktop pass confirmed persisted distinct assignments, a read-only non-designated admin, owner draft/submission without approval/send rights, exact-version approver acknowledgment and persisted approval, designated-sender availability, active-offer configuration locking, external manual handoff persistence, and a downloaded packet retaining all six synthetic caveats without offer tokens.
- The sender's final send confirmation was not opened or used. Preview interruptions and an existing product-tour overlay prevented completion of the agency browser view and mobile screenshot; those visual checks are not claimed. Agency/configuration/send denial is covered by server checks.
- A subsequent broad lint/test command timed out before the test rerun began under resource contention. The original seven-test pass remains recorded; the final legacy-path expansion is checked directly on the retained native/external synthetic fixtures.
- Final read-only fixture verification passed: native approved but unsent, external without native offer, original earlier evidence unchanged, agency/admin role alone denied, designated sender authorised, managed-flow legacy bypasses blocked, applications still applied, and zero outcomes/fee items.
- Isolated browser actors were subsequently suspended and their temporary session fixture removed; retained synthetic evidence and unsent draft/approval remain non-production test data.

## Deliberately not claimed

No Greenhouse connection, ATS upload/status synchronization, separate HR portal/role, HR notification inbox, or confirmed employment. The existing active-staff departure recovery limitation remains: configured active offers require explicit withdrawal by an available designated operator before changing ownership. Initial legacy adoption is not a general role-bypass recovery mechanism.
