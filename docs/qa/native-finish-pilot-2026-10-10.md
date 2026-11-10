# Retained native pilot: decision and controlled-offer continuation

## Scope

- Reused the retained, server-marked `controlled_inbox` synthetic pilot in its isolated tenant.
- No new interview, retrospective grading, LLM prompt/model/provider change, external sourcing restriction, or change to older Linx work orders.
- All six operational workflow steps were already completed. This is not a claim that every provider, identity check, or candidate qualification is cleared.
- The completed interview has five captured and graded answers. Its stored score is 46/100 and its recommendation is Yes. The disagreement warning remains; neither value was rewritten to make the test pass.
- Identity remains pending, the candidate remains excluded from real hiring statistics, and employment outcomes and fee items are zero.

## Gap found and repaired

The staff browser inspection found a completed legacy final note with no structured hiring intent. The UI correctly did not infer Hire, but had no safe decision-entry path from this terminal state.

The repaired path records a first structured decision explicitly:

- It defaults to Hold, requires acknowledgement of the legacy note and outstanding warnings, two written reasons, and a separate confirmation.
- The server requires an authorised human approver, exact revision, current approved job/journey, complete preceding reviews and an intact completed legacy final step.
- It preserves the legacy note and earlier evidence. It does not fabricate a superseded structured decision.
- The dedicated audit operation distinguishes the first recording from an ordinary correction.
- It rejects unexpected existing offers/history, stale requests, cancelled/paused workflows, and unauthorised access.
- Subsequent offer terms still need normal version-bound review and approval. Nothing sends merely because a decision is recorded.

## Checks

- One staff browser pass verified the retained report, its human-review disagreement warning, five graded captures, six-stage history and the original legacy blocker.
- The focused controlled-offer HTTP test group passed: five tests including the outer group and four nested scenarios.
- The new legacy scenario covers denied acknowledgement-free and recruiter requests, retry-safe recording, preservation of prior steps and legacy note, rejection of a misleading second legacy recording, held draft, approval, simulated delivery and public acceptance.
- Existing correction scenarios cover unsent approval reset, sent/accepted retention with acknowledgement, concurrency, stale/hidden/foreign/cancelled/in-flight rejection, and no employment/fee writes.
- HTTP fixtures use private test tables and intercepted email transport. Public acceptance in that test is not proof of real inbox delivery.
- Frontend typecheck and changed-file lint passed. Managed API/frontend restarted successfully; API build/guard checks passed.
- The standalone backend-wide typecheck has pre-existing repository errors; it is not a clean repository-wide result. After refreshing the generated contract declarations, it reports no errors in the changed files.

## Focused live UI continuation

The same browser tester verified only the repaired path, not another interview:

- `Record structured decision` appeared. Review remained disabled without the legacy acknowledgement; a separate confirmation was required after acknowledgement.
- The explicitly synthetic Hire intent was recorded with an internal-workflow-only rationale, not an endorsement of the candidate. The dedicated audit event preserves the prior note.
- A manually authored version-1 `TEST ONLY` offer draft was saved and survived reload: fictional employer/role, remote internal test, USD 1 annually, start 2026-11-01 and expiry 2026-10-17.
- The draft remained **not submitted for review** and unapproved. No offer was sent or accepted.
- Identity-pending and score/recommendation disagreement warnings remained visible.
- The protected decision and draft were checked at 390px. The long employer value clips inside its input but the full stored value was verified.
- The read-only verifier confirmed unchanged preceding-step fingerprints, unchanged original interview/assessment fingerprint, unchanged application stage (`interview_completed`), continued synthetic-statistics exclusion, pending identity, and zero employment/fee records.

The held letter deliberately prohibits sending/accepting. Before any separately authorised delivery test, replace that instruction with clear test-response instructions and review/approve the resulting exact new version. Do not bypass the version-bound approval.

## Authorised single-email continuation

The user explicitly authorised one synthetic offer email. The ordinary scoped API saved version 2 with test-response instructions, preserving every fictional financial/date term, then submitted that exact version for review, approved it, and sent it once. The previous draft remains in offer history.

The offer is now `sent` with a non-simulated, non-demo transport receipt. This proves provider acceptance, **not inbox delivery or recipient response**. No automatic resend is authorised. The recipient must choose their own test Accept or Decline; never respond on their behalf.

The send driver requires the retained controlled-inbox marker, the existing isolated reviewer, the explicit recipient, original version-1 draft and exact fictional terms. Its private create-once journal preserves distinct action idempotency keys. It will not rerun over a sent/uncertain offer.

The post-send read-only check passed against the original baseline: preceding steps, interview/assessment and application stage unchanged; pending identity and synthetic-statistics exclusion preserved; employment outcomes and fee items both zero. The exact version-2 approval, sent timestamp and genuine transport receipt were present. Temporary reviewer browser authentication was removed after verification. Both QA scripts passed focused lint and formatting checks.

No pilot offer email is authorised by this verification; the live draft must remain held until a separate explicit send approval.
