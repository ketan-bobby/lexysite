# Google Meet recording authorization — development

## Delivered boundary

Staff can manage a separate optional read-only recording connection under
**Settings → Calendar** (`/settings/calendar`). Connecting does not authorize a
download, transcription, score, candidate communication or hiring decision.
Existing Calendar connection, invitation scopes and disconnect are unchanged.

The authorization uses browser-bound state, PKCE, a verified Google identity,
one-time callback consumption and employer/staff-bound encrypted refresh
credentials. Revision checks fence stale callbacks, disconnect and refresh
responses. Missing or downgraded recording scopes fail closed.

Only active staff with an employer context can connect. Candidates cannot read
or change this connection. Failed authority reads and mutations hide cached
account details until a fresh successful read.

## Operator setup for later live acceptance

Reuse the configured staff Google OAuth application; do not replace its Calendar
callback. Add **one additional** exact callback, displayed by the recording card:

```text
https://<the-configured-API-origin>/api/google-meet-recordings/callback
```

The consent return is the existing configured Calendar settings URL. The
additional scopes are `meetings.space.readonly` and `drive.meet.readonly`.
The latter is restricted; the Google application must have the required consent
screen configuration, testing/publishing access and applicable Google review.
This does not request account-wide Drive browsing or amend existing grants.
No new secret values need to be pasted into the settings page.

Migration `lib/db/drizzle/0110_staff_google_meet_recordings.sql` is additive.
It was applied **only to the verified development database**. The table has
forced RLS, no request-role/public privileges, complete-grant/complete-flow
constraints and a unique state hash. Do not assume external production receives
this migration on publish. Production changes remain deferred.

## Verification

- Provider/account regressions cover narrow scopes, token/identity verification,
  one-time consumption, expiry, foreign user/employer access, credential-purpose
  separation, concurrent callbacks and revocation races.
- HTTP regressions cover authentication, literal consent, strict request bodies,
  scoped secure cookies and fixed callback destinations.
- `check-meet-recording-store.ts` uses a fingerprint-confirmed development
  connection and a rollback-only temporary clone; no real staff grant is
  inserted. It checks real SQL ownership/CAS behavior, constraints and denied
  request-role access.
- New unit/HTTP/UI-state suites are registered in the assisted release manifest.
  The real read-only schema gate checks the new table, defaults, constraints,
  index, RLS and privileges.
- API/frontend typechecks and changed-source lint passed. The API build and
  existing security guards passed after the managed server restart.
- The signed-in browser pass used a unique synthetic staff account and real
  login. The actual endpoint/card agreed on `setup_required`; mock endpoint
  responses then verified consent, hostile-redirect rejection, disconnect,
  denial/recovery privacy and a 402px layout. All fixture rows were removed.
  No Google authorization or recording read occurred.
- That pass found no manual recheck control after a 403; it recovered through
  focus instead and reported the planned Retry interaction unavailable. A
  **Check access again** control was added afterward and checked by source,
  typecheck and lint, not by another browser pass. Account details remain
  hidden until its fresh read succeeds.

Useful targeted commands:

```sh
pnpm --filter @workspace/api-server exec tsx \
  --experimental-test-module-mocks --import ../../scripts/test-egress-guard.mjs \
  --test src/lib/google-meet-recording-{oauth,account}.test.ts \
  src/routes/google-meet-recording-account.test.ts
MEET_RECORDING_TEST_DB_CONFIRM=<verified-development-fingerprint> \
  pnpm --filter @workspace/api-server exec tsx \
  --import ../../scripts/test-egress-guard.mjs scripts/check-meet-recording-store.ts
node scripts/check-recent-db-schema.mjs
```

## Still pending

Live Google consent has not been exercised. Appointment/candidate/job-bound
conference selection, signed preview review, bounded private persistence,
source receipts and user-facing recording-review controls have now been added;
see [the application test boundary](native-google-meet-recording-import-development-2026-11-04.md).
Zoom remains a separate native provider flow. The shared private-storage
deduplication recovery now also rechecks source authority before returning an existing copy.

No full assisted release run was repeated here; preserve its earlier recorded
failure and later targeted corrections rather than calling the whole gate green.
