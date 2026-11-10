# Staff-owned Google Calendar setup

## Delivered scope

Settings → Calendar preferences now has a staff-owned Google Calendar connection
and a deliberate check of one personal interval. The project-connected account
remains a separate platform-admin diagnostic; it is never selected for staff.

Supported active staff roles are platform admin, tenant admin, recruiter admin,
recruiter, hiring manager and interviewer. Candidates cannot access this API.
Every stored row and operation is scoped to both the staff user and their owning
employer/agency tenant. Client job sub-tenants do not become calendar owners.

Authorization is read-only **by default**. Staff may now explicitly opt into
owned-event permission; the returned Google scopes must prove it before Lexy
marks the connection invitation-capable. That still grants no panel sharing or
candidate access to private calendars. Every send requires its own staff review.

## External configuration needed

One Lexy-owned Google OAuth application supports all staff; individual staff do
not create Google Cloud applications or supply credentials.

1. Enable Google Calendar API in the Lexy Google Cloud project.
2. Configure the OAuth consent screen. For an external testing application,
   include the intended internal test accounts as Google test users. Before
   public rollout, complete Google's applicable consent/verification requirements.
3. Create a web-application OAuth client. Register the exact callback URI for
   each environment; don't mix development and production action links.
4. Set these server-side values through the project's environment/secrets tools:

| Name | Purpose |
| --- | --- |
| `GOOGLE_CALENDAR_CLIENT_ID` | Lexy's Google web OAuth client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Confidential client credential; server secrets only |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Exact HTTPS callback ending `/api/google-calendar/callback` |
| `GOOGLE_CALENDAR_SETTINGS_URL` | Exact HTTPS staff-app destination ending `/settings/calendar` |

`SESSION_SECRET` or `AUTH_SECRET` is also required for authenticated encryption.
The existing token vault is reused without accepting its insecure development
fallback for this feature's setup readiness.

Do not paste secret values into chat, source files, screenshots or setup docs.
Do not extract a managed connector's credentials for this flow. The managed SDK
supports project-connected reads but does not itself prove the corresponding
Lexy staff/employer authorization. Staff onboarding here uses explicit Google
OAuth identity verification rather than assigning that project connection.

Scopes requested:

```text
openid
email
https://www.googleapis.com/auth/calendar.calendars.readonly
https://www.googleapis.com/auth/calendar.freebusy
```

The application requests offline access and explicit account selection/consent.
Google-signed identity claims, client audience, issuer, freshness, verified
email and nonce are checked. Account ownership is not inferred by comparing
the Google email to a Lexy email.

The optional invitation checkbox additionally requests
`https://www.googleapis.com/auth/calendar.events.owned`. Existing grants remain
read-only until a new explicit consent flow verifies this scope. This permission
allows the controlled candidate-only invitation described in
[Google interview invitations](google-interview-invitations.md), not background
sends, arbitrary calendar operations or panel sharing.

## Database rollout

Migrations: `lib/db/drizzle/0087_staff_google_calendars.sql` and
`lib/db/drizzle/0088_google_interview_invitations.sql`.
It adds one private staff table, complete-grant/flow constraints, unique flow
hash indexing, forced RLS and revocation of public/application-role access.
The table has a cascading user foreign key. Token envelopes also bind purpose,
staff user, tenant and credential kind, protecting against ciphertext swaps.

The migration has been applied only to the independently verified development
instance. Publishing is not proof that an external production database has
received it. Confirm the production target and follow the established rollout
process before publishing code that needs this table.

Development verification utility:

```sh
# Obtain the existing fixture's identity through the explicit DEVELOPMENT handle:
# scripts/recent-db-schema-sql-fixture.mjs exports developmentFingerprintSql.
pnpm --filter @workspace/api-server exec tsx scripts/staff-google-schema.mts DEVELOPMENT_FINGERPRINT
# Optional additive development rollout, only after the rollback fixture passes:
pnpm --filter @workspace/api-server exec tsx scripts/staff-google-schema.mts DEVELOPMENT_FINGERPRINT --apply
```

Without `--apply`, the utility uses an ORM-owned outer transaction and private
schema, passes its transaction handle to repository operations, and rolls
everything back. It verifies cleanup afterwards. Never pass a production
fingerprint to this development fixture.

The read-only recent-schema audit also checks this table, its columns/defaults,
forced RLS, absent policies and revoked public/application-role grants.

## Staff behavior and failure recovery

- Local status reads can refresh; no provider availability query runs on page
  mount, focus, reload or polling.
- Starting/replacing a connection deliberately clears the previous local grant.
  Pending consent can be cancelled. A later consent flow invalidates earlier ones.
- The OAuth callback requires the current authenticated active staff identity,
  the browser-bound secure HTTP-only cookie, unexpired PKCE flow and one-time
  database consumption. A different logged-in user cannot finish another user's
  flow.
- Disconnect deletes local credential envelopes and invalidates pending flows.
  It does not claim to revoke the entire Google-account consent. Staff can
  additionally remove Lexy's permission through their Google account controls.
- Disconnect/new authorization fences late callback and refresh persistence.
  Changed or suspended users and late availability results fail closed.
- The interval is future-only, at most 90 days ahead and 15–480 minutes long.
  Saved working hours, including explicit empty windows, are enforced.
- Only the owner receives free/busy/outside-hours status; raw events, calendar
  IDs and busy intervals are never returned. The response is not a reservation.
- Temporary provider failures are unknown, not free. Revoked credentials require
  reconnection. There are no automatic provider retries.
- Results clear on input, identity, tenant, connection revision, focus or error.
  Response validation binds the exact interval and forbids write-enabled receipts.

## Live acceptance still required

After external configuration and the approved deployment schema rollout:

1. Two staff members in different employers authorize their own Google accounts.
2. Confirm account selection and local status persist after reload and remain
   private to the owner; candidate and foreign-staff access stay denied.
3. Check known busy/free intervals and an interval outside saved working hours.
4. Disconnect/cancel, exercise reconnect and stale-tab recovery, and revoke
   Google permission to confirm unknown/reconnect behavior.
5. Confirm connection/preferences controls and candidate pages never reveal a
   full calendar, create a meeting or send an invitation. The separate staff
   invitation control is the only new reviewed write path.
