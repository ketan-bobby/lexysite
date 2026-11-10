# Controlled offer ownership recovery

## Scope

The employer's active tenant administrator can explicitly replace unavailable native offer assignees through the existing work-order offer-ownership panel. General financial authority still comes only from designation.

- Written reason, acknowledgement, separate confirmation, exact workflow revision and durable idempotency.
- Replace only unavailable staff; available owner/approver/sender stay unchanged.
- Same employer, active eligible replacements, native process unchanged.
- Unsent review/approval resets to draft, preserving the old approved snapshot. Fresh human review/approval is required before sending.
- Delivered terms/version, transport/capability metadata and recipient response remain unchanged.
- Sending/uncertain delivery and inconsistent unsent-with-delivery evidence remain blocked. Recovery never releases or retries a send claim.
- Original preceding-stage evidence, hiring decision, workflow status and application stage are not changed.
- No candidate delivery, interview, provider execution, pricing gate, LLM/rubric/provider change or older Linx work-order update.

## Verification

- Focused real PostgreSQL/HTTP controlled-offer group: **10 tests passed**.
- Added cases cover role/tenant permissions, unavailable-only replacement, revision/idempotency, ordinary-lock and legacy-adoption separation, rejection of external-mode takeover, unavailable replacements, approval reset, archived original terms, and draft/review/sent/accepted/declined/sending/uncertain/inconsistent-delivery states.
- All test transport is intercepted with external networking denied. No new emails were dispatched by recovery.
- Generated contract/client/validators rebuilt; frontend typecheck and targeted backend lint passed.
- Signed-in browser: approver-only recovery, blank/reason-only disabled controls, separate confirmation, Back without mutation, and one explicit confirmation all verified. Routing persisted with only the unavailable approver replaced; offer became draft v1 and the earlier approval remained in history.
- Direct persisted-state check passed: original terms/version and earlier five stages unchanged; owner still cannot send, application stage unchanged, no delivery/outcomes/fees. Only fictional actors were retired and their temporary session file removed.
- Browser limit: the session closed before owner detail controls, unassigned-admin inbox and 390px post-recovery checks finished. Do not describe these as browser passes; existing scoped HTTP checks cover permissions and send eligibility.
- Initial navigation into Intelligence triggered one deterministic fixture-only score calculation. The route calculates stored signals without external model calls; it did not execute a workflow, offer or provider action. Corrected navigation used **Overview → workflow controls**, not candidate-name scoring buttons.

## Consolidated regression

- All **516 API tests across 40 files** passed, including the three bounded workflow-journey batches.
- All **50 web-logic tests** passed; batch-planner and external-egress guard tests also passed.
- The overall shell deadline expired during frontend typecheck. No API/web test failed. Remaining quality checks were resumed separately, without repeating the successful suites.
- Frontend typecheck, API build/security guards and lint passed. The format gate initially identified eight inherited files; formatting-only cleanup removed all new format failures. One grandfathered file remains allowed by the existing quality baseline.
- This is not a clean whole-backend TypeScript result or a live certification of every provider, identity proof, language and device. Protected recovery was checked in the browser only to the extent listed above.

## Remaining boundaries

Recovery is not a tool for resolving an unknown delivery outcome. That requires independently corroborated attempt evidence; do not infer that no letter was delivered from a timeout. External ATS handoff remains manual/disconnected. Actual identity clearance, employment and fee confirmation remain separate.
