# Google Calendar read-only pilot — 2026-10-24

## Implemented boundary

Platform administrators can deliberately run a project-connection read
diagnostic from **Settings → Calendar preferences → Google Calendar pilot**.
`POST /api/google-calendar/pilot-check` accepts only
`{"confirmReadOnlyCheck":true}`.

This is not a staff calendar connection, customer OAuth onboarding, a calendar
browser, candidate availability publication, a meeting-creation feature or
invitation approval.

The server resolves an active stored staff identity and then requires
`platform_admin` before constructing the SDK gateway. It selects exactly one
accessible Google Calendar connection by explicit provider connection ID.
No caller-supplied calendar, connection, date window or tenant is accepted.
No arbitrary default account is chosen when there are multiple connections.

Only these Google operations are permitted:

1. Primary calendar metadata with a fixed, minimal fields selection.
2. A free/busy query for that same calendar over a server-chosen 15-minute UTC
   window, with expansion limited to one calendar.

The free/busy POST is a provider read, not event creation. Event, ACL and other
paths are denied before SDK proxy access. The provider response is checked for
the exact calendar and interval; partial errors and malformed data cannot
become a successful availability read.

The response contains only verification booleans, a check timestamp, the
advertised Meet capability and explicit `accountBinding:"not_configured"` /
`invitationsEnabled:false`. Account identifiers, names, event contents and busy
intervals are not returned, persisted or logged. SDK exception text is not
forwarded to the client or application logs.

No provider read occurs automatically on page mount, reload, focus or polling.
Duplicate in-flight clicks are guarded in the UI and concurrent project checks
are rejected by the endpoint. Prior success is cleared before a new check;
failed or inconsistent receipts never retain a green result. User changes
reset the card and abort its fetch. Diagnostics have bounded waiting; a
provider read already in progress is not a cancellable calendar transaction.

## Verification

- **Live, read-only:** the sandbox connection returned HTTP 200 for primary
  metadata. The new server-side SDK gateway separately passed the actual
  metadata/free-busy diagnostic and returned a sanitized verified receipt.
  The calendar advertises `hangoutsMeet`. This does not prove event-write
  permission, successful conference creation or guest delivery.
- **23 backend checks passed** across core response validation, SDK routing,
  timeout and endpoint branches. Provider calls are intercepted. HTTP route
  tests use mocked identity/staff resolvers; they are not a live staff-login
  or database-RLS certification.
- **3 frontend state tests passed** for honest capability, non-authorization
  and malformed/write-enabled receipt handling.
- **6 isolated browser scenarios passed** using the real component, auth
  provider and generated client with synthetic intercepted API responses.
  Coverage includes no automatic checks, duplicate clicks, reload,
  non-admin roles, changed administrator identity, failed/malformed receipts,
  deliberate recovery, missing/multiple connections and 390px controls.
- **14 existing Outlook panel browser scenarios still passed** after the
  isolated fixture gained its separate Google mode.
- Shared-library, API and frontend strict typechecks passed. Scoped lint and
  repository formatting passed. The managed API build/security checks
  completed and both services restarted successfully.
- The running endpoint returned **401** for an unauthenticated request.
- A login screenshot confirmed the app remains available. The Google card's
  behavior was verified through the isolated browser cases, not that screenshot.

Commands:

```sh
pnpm --filter @workspace/api-server run test:google-calendar
pnpm --filter @workspace/api-server exec tsx --import ../../scripts/test-egress-guard.mjs --test ../lexy/src/components/scheduling/google-calendar-pilot-state.test.ts
pnpm --filter @workspace/lexy run test:google-calendar-browser
pnpm run test:panel-invitation-browser
```

The backend tests and frontend state tests are registered in the assisted
baseline; the Google browser command is a required additional step. A complete
expanded baseline run was not performed here. The prior full report must not
be relabelled as a pass of this expanded gate.

## Remaining Google scope

1. Establish independently verified staff/employer-to-provider account binding
   and explicit self-service authorization/revocation. A project connection
   or a matching email string alone is not that authorization.
2. Implement staff-owned bounded availability and sharing consent, retaining
   working hours and candidate-visible offered slots only.
3. Implement separately reviewed Google invitations/Meet creation with durable
   intent, one invitation owner across providers, explicit changes and
   read-only reconciliation of uncertain results.
4. Verify actual privacy, permissions and delivery through an authorized
   synthetic live acceptance session.

No Google events, meetings, invitations, ACLs or settings were changed by this
work. No database migration, production rollout, billing change or AI/model/
prompt/provider-routing change was made.
