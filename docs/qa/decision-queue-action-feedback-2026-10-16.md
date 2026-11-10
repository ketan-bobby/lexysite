# Decision Queue action feedback

## Gap closed

The Decision Queue's Execute Action button previously parsed every response as
success without checking its HTTP status. It also gave no visible explanation
when the API correctly declined execution for approval, policy or manual-step
reasons.

The client now checks HTTP status and receipt structure before treating a run
as accepted. It displays permission/session errors, policy/approval blocks,
manual-step explanations and accepted-run references inline. Accepted means
accepted, not completed or delivered.

POST retries are explicitly disabled. Network failures and unreadable receipts
warn the recruiter to inspect Agent Activity before another attempt, because
the server may already have accepted the request. This is not server-side
idempotency or a guarantee against repeated deliberate clicks.

Only an accepted run invalidates the intelligence query family. No backend
execution, approval requirement, tenant scope, model, prompt, provider routing
or subscription entitlement changed.

## Verification

- Five response-handling tests passed, covering accepted runs, eight HTTP error
  statuses, approval/policy blocks, manual steps and malformed receipts.
- Strict frontend typecheck passed.
- Targeted ESLint: zero errors; four existing warnings in the queue page.
- New tests included in the existing assisted-baseline frontend test list.
  The full baseline was not rerun for this bounded client-side change.
- Running preview rendered the anonymous sign-in screen. The protected queue
  and its interaction-only feedback were not inspected through that screenshot.
- Vite reported a hot update for the changed queue page.

No real execution request, email, invitation, offer, paid provider call,
database migration or production deployment was performed for this check.

## Remaining boundaries

This closes one in-system reliability issue, not the whole original competitive
audit. The native workflow engineering closeout remains separate from Linx
human acceptance, live AWS checks, employer-authorized calendar/ATS connections,
production deployment verification and deferred invoice reconciliation.
The candidate-registration inventory's production deployment is also separate.
