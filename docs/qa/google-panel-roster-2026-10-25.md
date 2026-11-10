# Google native panel persistence — 2026-10-25

## Delivered

- Staff-reviewed Google-only panel/time save and deliberate removal.
- Saved roster display after reload/remount, separate from directory health.
- Provider-specific private bindings; legacy Outlook JSON remains supported.
- Cross-provider overwrite/removal protection on server and client.
- Atomic native schedule/panel writes with version comparison and removal tombstones.
- Current Google consent, identity, working hours and availability checks at
  save, staff time/duration edit, signed-in confirmation and public booking.
- Credential rotation persistence survives a later failed availability check.
- Internal candidate checks use the owner-scoped transaction without changing
  the candidate's request identity, role or normal database visibility.
- Existing scope helpers accept an optional explicit reader for these internal
  checks. All other callers retain the original request-scoped default.

## Verification

- 171 Google/Outlook/Meet/slot backend unit and HTTP tests passed.
- Real HTTP/PostgreSQL fixture suite: 101 existing/new cases passed in the
  combined run; the remaining normal-recruiter fixture was corrected to model
  real agency talent, canonical portal identity and assigned-interviewer rules,
  then passed in a focused run. These are isolated, owned development schemas,
  not writes to live customer rows.
- The eight new Google SQL/HTTP cases cover durable save/read, concurrent CAS,
  busy/unknown calendars, rotated credentials, unhealthy removal, identity and
  consent changes, cross-provider protection, atomic rollback, public booking,
  duration changes and current normal-recruiter ownership.
- 34 actual-component browser scenarios passed with mocked HTTP, including
  remount, account changes, explicit review/save/remove, malformed or uncertain
  results, Outlook read-only behavior, directory refresh during a pending write,
  and 360px layout.
- Backend and frontend typechecks passed during implementation; the managed
  API restart runs its normal final typecheck and static guard chain.
- Scoped lint had no errors; existing hook/unused-import warnings remain.

The first full SQL run found that a candidate request could not recheck a
staff panel through its default restricted connection. The fix uses the
already owner-authorized transaction and explicit staff-scope reads; it does
not widen candidate RLS. The passing ordinary-recruiter scenario also verifies
that request role, canonical candidate context and normal job visibility stay
unchanged before/after confirmation, and assignment revocation is respected.

## Release boundaries

No additional public DDL is needed for provider-tagged JSON roster members.
The previously documented private calendar/panel migrations, including Google
sharing permissions, are still prerequisites. No production database changes
were made. API and frontend should be released together.

Browser HTTP and provider transports were mocked; PostgreSQL and application
middleware were real in the private fixture. This is not real Google-account
acceptance, production RLS verification or a full assisted-baseline run.

Saving is native only: no external reservation, candidate choice publication,
invitation, email or provider meeting write is performed by these endpoints.
Google panel invitations and mixed-provider panels remain separate work.
Existing API startup jobs can emit their pre-existing Stripe-key admin alert;
that is not an invitation or a billing enablement by this feature.
