# Candidate Google Meet — 2026-10-25

## Verification

- Backend: **149 Google/Outlook and candidate projection tests passed**,
  including 14 new candidate projection/HTTP tests.
- Frontend: existing 20-scenario isolated real-component pass, followed by
  four focused new regressions for same-ID role change during Join, unmount
  during Join, and pending/error focus refresh. **24 covered scenarios**.
  The complete expanded browser suite was not rerun after those targeted fixes.
- API and frontend strict typechecks and shared generated-library build passed.
- ESLint passed on all 16 changed source files; whitespace checks passed.
  The repository-wide lint attempt exceeded its combined command budget, so
  no whole-repository lint pass is claimed.
- Backend checks include original and moved bookings, malformed receipts and
  history, pending operations, cancellation followed by native restoration,
  changed credentials/identity, own-user scoping, safe URL validation, minimal
  serialization, generic errors and read-only HTTP behavior.
- Private note/feedback edits preserve a provider-accepted candidate-visible
  binding. Public booking changes do not. Legacy receipts retain stricter
  full-snapshot matching. Staff receipt reads can preserve acceptance through
  private edits without resending.
- Join works at the appointment start, during the meeting and in the one-hour
  post-end reconnection grace; it does not expose links indefinitely.

## Boundaries

The component uses the generated GET client with uncached reads, identity and
booking cache keys, finite visible polling and a fresh read before same-tab
navigation. Role/identity/prop changes abort pending Join requests, as does
unmount; the Join request has a ten-second timeout. Loading/refetch/error states
do not display a cached Join control.

The source query constrains both canonical candidate and owning portal user
through the application. Foreign IDs and missing IDs return identical 404s.
Anonymous and non-candidate sessions never enter the private reader. Tests
inject synthetic identities at the HTTP boundary; they do not constitute a
new real signed-in database/RLS or live OAuth acceptance test.

All provider, credential, candidate and appointment evidence is synthetic.
There were no real calendar operations, candidate messages, fixture database
writes, production changes, model/prompt/routing changes or billing changes.
Service restarts may run existing maintenance and configuration-alert jobs.

No new column or DDL migration is required. The optional candidate publication
binding is added to existing private receipt JSON by already-authorized staff
writers after provider verification, never by a candidate read.

This is stored-acceptance projection, **not** a live Google check. Manual edits
made solely in Google remain outside this reader's knowledge until staff
reconciliation or future synchronization observes them.

## Persistent commands

```sh
pnpm --filter @workspace/api-server run test:candidate-google-meet
pnpm --filter @workspace/lexy run test:candidate-google-meet-browser
```

Both suites are registered in the assisted baseline. Registration is not a full
assisted-baseline pass. Real staff consent and a consenting isolated live booking
still require release acceptance.
