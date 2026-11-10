# Native final-decision corrections

## Behaviour

Authorised human approvers can explicitly correct a structured final Hire, Hold or Decline decision on a current, approved workflow. Both the new decision rationale and the reason for correcting it are required. Server-owned actor, timestamp and synthetic classification are recorded.

The previous decision is appended to history without changing its actor, timestamp or rationale. Original reviewed step evidence remains unchanged. Hold reopens the human decision for review; Hire/Decline complete that decision. No application stage, employment record or fee is changed.

Any unsent draft/review/approved offer becomes a new draft version requiring fresh review and approval, even if only the hiring rationale changes. The prior offer version remains in history. Delivered, accepted, declined or uncertain offers stay unchanged and require explicit acknowledgement; withdrawal is a separate action. In-progress delivery blocks correction.

Legacy free-text completed steps are not inferred as hiring decisions. Scope, candidate privacy, revision, journey approval and idempotency are checked at the server. Concurrent corrections cannot silently overwrite each other.

## Verification

- Workflow HTTP/regression suite: **40 passed, 0 failed**, including three new correction subtests and the existing workflow/controlled-offer checks.
- Checked missing/blank reasons, forged actor/test classification, no authentication, incorrect roles/tenants, stale revisions, duplicate keys, conflicting corrections, mismatched workflow/job IDs, paused/cancelled workflows, changed briefs, legacy notes, hidden candidates and in-progress delivery.
- Checked unsent approval reset/history, valid sent links after correction, accepted-offer preservation and absence of employment/fee effects.
- API build and ownership/privacy guards passed; shared library typecheck, frontend typecheck and targeted lint passed.
- One signed-in browser pass confirmed Hire → Hold, required reasons, preserved history/evidence, approval reset and persisted reload.
- Preview interruption prevented that pass finishing. The preview was restored and the same tester completed only the interrupted tail, not a repeat of the first correction.
- The tail verified Hold → Decline, original Hire/Hold history, unapproved offer v3, and a second browser context whose stale form could not submit until explicit refreshed-state review. Typing valid reasons did not clear the stale warning.
- An unsigned recipient accepted an isolated fake-delivery offer. A staff Hire → Decline correction was blocked until acknowledgement, then retained the accepted offer unchanged after public reload.
- Both staff pages were checked at 390px with no horizontal overflow.
- Final database inspection confirmed unchanged application stages, preserved original evidence, correct decision/offer histories, **zero employment outcomes and zero fee items**.
- All isolated browser records and the private fixture file were removed.

## Limits

No real email, interview, provider call, model/prompt/rubric change, subscription restriction, external-sourcing disable or historical Linx rewrite occurred. Synthetic fixtures prove workflow behaviour, not candidate qualifications or real provider delivery. No physical schema migration was required.

The next native-plan milestone is assessment-quality validation, followed by one planned Linx end-to-end test. Cost reconciliation remains parallel; ATS integration follows the native milestones.
