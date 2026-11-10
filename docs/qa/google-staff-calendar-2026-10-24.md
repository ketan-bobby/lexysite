# Staff Google Calendar implementation evidence — 2026-10-24

## Verified

- API, shared-library and frontend strict typechecks passed.
- **45 Google backend checks passed**, including the original 23 project-pilot
  tests and 22 new staff provider/workflow/HTTP checks.
- Signed synthetic ID-token tests exercise real JWT verification with local
  keys: issuer, audience, expiry and signature rejection are tested without
  contacting Google.
- OAuth replay, owner/employer mismatch, browser binding, denial, expired state,
  newer consent, suspension, disconnect races, credential-context swaps,
  invalid intervals, unknown availability and revoked grants are covered.
- **12 new persistent staff browser scenarios passed** using the real component,
  auth provider and generated client against isolated synthetic responses.
  These include late OAuth responses after user changes, exact receipt/interval
  binding, clearing stale results, scoped cache identity, disconnect, recovery,
  setup-required/callback copy and a 390px layout.
- The affected harness's **14 Outlook** and **6 Google pilot** scenarios passed
  after staff mode was added. No real OAuth navigation, provider write or
  invitation is allowed by the fixture.
- **14 schema-audit/generator checks passed** after registering the new private
  table. The real read-only metadata audit passed.
- An independently development-targeted, real PostgreSQL rollback fixture
  passed repository owner/employer predicates, replay, CAS/revocation, private
  application-role denial and cleanup.
- Migration `0087_staff_google_calendars.sql` was applied to that verified
  development instance only. Forced RLS and revoked application-role access
  were checked.
- Repository lint/format checks passed. The managed API build/security checks
  completed and both services restarted.

## Important limits

Workflow/provider/HTTP tests intercept Google and mock staff identity resolvers.
The SQL fixture proves repository isolation and table privileges, not a real
staff login. Browser OAuth navigation is intercepted, not a real authorization.

The four dedicated `GOOGLE_CALENDAR_*` application settings were absent. No
real staff OAuth grant, refresh, own-calendar availability query or disconnect
was claimed as live-verified. The staff UI explicitly reports setup required.
The previously connected project account was not used as a fallback.

No production migration/deployment was performed. No Google events, Meet links,
invitations, panel grants, billing rules or stabilized AI settings were changed.
The expanded assisted baseline includes these tests, but its entire gate was
not rerun; these focused passes must not be relabelled as a full-gate pass.

Setup and remaining live acceptance:
[Staff Google Calendar setup](../engineering/google-staff-calendar-setup.md).

Commands:

```sh
pnpm --filter @workspace/api-server run test:google-calendar
pnpm --filter @workspace/lexy run test:google-staff-calendar-browser
pnpm run test:panel-invitation-browser
pnpm --filter @workspace/lexy run test:google-calendar-browser
node --test scripts/check-recent-db-schema.test.mjs scripts/recent-db-schema-sql-fixture.test.mjs
node scripts/check-recent-db-schema.mjs
```
