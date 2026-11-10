# Google interview operations — 2026-10-25

## Completed checks

- Shared Google and Outlook backend run: **135 tests passed**, no failures.
  Includes **20 new** operation/transport/HTTP checks for explicit approval,
  expiry, rotated proofs, immutable details, concurrent submissions, native
  cancellation, source ETags, conflict detection, private eligibility, changed
  accounts, lost PATCH/DELETE responses, persistence failures and recovery.
- Same-subject reconnection invalidates the old approval but permits a newly
  reviewed operation. A different verified Google subject cannot inherit the
  event. The original send receipt remains immutable.
- New real-component Google operation browser suite: **13 passed**.
- Existing Google invitation browser suite: **15 passed**.
- Existing Outlook panel invitation browser suite: **14 passed**.
- API and frontend strict typechecks passed. Generated clients/types were
  rebuilt from the operation contract.
- Repository lint: zero errors; 503 warnings remain.
- Coordinator source inspection confirms the new action is outside the native
  ScheduleActions conditional and the schedule query does not exclude cancelled
  records. The browser suite mounts the actual operation component, not the
  whole authenticated coordinator page.
- Both managed services restarted successfully, including API build guards.

## Storage and safety boundaries

There is no new table, column, DDL migration or test-booking/fixture write
performed by this verification. Optional operation history uses the existing private Google
receipt JSON, schedule send-attempt primary key and erasure barrier. Existing
rows without operation history remain supported.

Native cancellation is allowed through the shared lock helper only with the
explicit Google-operation option; all existing callers retain confirmed-only
eligibility. Candidate contact/privacy, approved job, future schedule, staff
scope and current account checks still apply. Cancellation does not send a
Lexy email or mutate the native record.

Reschedule preflight inspects a bounded primary-calendar interval and excludes
only the original event; other overlapping, all-day, malformed and incomplete
results cannot become a false free slot. Neither event contents nor rosters
are included in responses.

An uncertain delete cannot be accepted merely from an absent event. The intent
remains under review and no second write is attempted. Unknown outcomes are not
proof of guest notification, RSVP, attendance or an atomic reservation.

## Limits and release

All provider/event identities and responses are synthetic and network-isolated.
No real OAuth consent, real staff login journey, Google update/delete,
candidate email, production migration or deployment was performed. OAuth setup
and real-account acceptance still require the team's approved isolated test.

Service startup did run existing background maintenance and the existing
unacknowledged-Stripe-key sentinel, which sent an administrator alert. Billing
remained dormant; no billing configuration or secret was changed.

The full assisted baseline was not rerun. Its API inventory and required
browser steps now include the new suites; registration is not a whole-baseline
pass. No AI model, prompt, routing, commercial tier or pilot limit was changed.

```sh
pnpm --filter @workspace/api-server run test:google-operations
pnpm --filter @workspace/lexy run test:google-operation-browser
```

See [implementation and operator boundaries](../engineering/google-interview-operations.md).
