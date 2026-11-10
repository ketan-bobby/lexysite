# Staff notification history

## Change

- Existing `GET /user-notifications` remains an array response with a default
  page of 50. Optional `limit` (1–100) and a caller-bound opaque `cursor` reach
  older records. `X-Next-Cursor` is absent at the end of history.
- Ordering uses timestamp plus notification ID. Cursors preserve PostgreSQL
  microseconds, including ties, rather than using truncated JavaScript dates.
- The staff page loads older pages, retains them across normal polling, and
  separates the overall unread count from the number of loaded records.
- Queries/cache keys are user-specific. Mark-one and mark-all retain their
  original caller-only authorization and update both loaded rows and the bell.
- Errors leave previously loaded records visible with retry controls. Historical
  records are not recreated, enrolled in automation or changed by pagination.

## Verification

- Four real Express/RLS/HTTP/database tests passed using disposable synthetic
  tenants/users: 130 microsecond/tied records across pages; a new arrival between
  pages; historical read state and overall unread counts; invalid and foreign
  cursors; same-tenant peer and foreign-tenant isolation; unauthorized/suspended
  callers; caller-only mark-all-read.
- Fixtures were deleted by exact IDs. No candidates, jobs, interviews or offers
  were created by these tests.
- Frontend TypeScript and changed-source ESLint passed. OpenAPI clients and
  validators were regenerated. The managed API build/security checks passed
  and both API/frontend workflows restarted successfully.
- Signed-in browser acceptance passed with a separate isolated 111-alert fixture.
  A simulated pagination 503 retained the first 50 rows and exposed retry
  feedback. Recovery loaded all 111 without duplicates. Reading the oldest
  row reduced the overall unread count without losing history.
- A fresh synthetic arrival appeared during normal polling, producing 112
  loaded entries without dropping the original rows. Mark-all/read state
  persisted after reload. Desktop and 390px phone controls fit.
- Browser contexts were closed; exact fixture tenant/user/notifications and the
  temporary session-token file were removed. No real account was used.

## Boundaries

This is in-app history, not proof of offer delivery, candidate consent, external
ATS synchronization or employment. AWS live checks remain deferred by the user's
instruction. Models, prompts, voice/STT providers, commercial tiers and external
sourcing availability are unchanged.
