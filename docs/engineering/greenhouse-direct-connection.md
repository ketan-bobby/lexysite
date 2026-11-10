# Greenhouse employer-owned direct read connection

The read contract described here remains read-only. A separate, explicitly
approved [interview-note publisher](greenhouse-interview-note-publication.md) now
supports fixed-purpose `POST /v3/notes` for the same allocated direct connection.
It requires the provider's note-creation grant and fresh employer approval;
credential presence alone is not write authorization.

Existing-note [recovery](greenhouse-note-recovery.md) uses a separate fixed
`GET /v3/notes?ids=<one ID>` method and the provider's note-read permission.
The general read allowlist is not widened and no missing-note resend is enabled.

## What is implemented

The existing Greenhouse verification, scoped application preview, reviewed metadata
and profile intake, and refresh services can now use a direct Harvest v3 OAuth
client-credentials transport. These paths no longer require a workspace connector
when the direct transport is explicitly configured. Existing tenant, employer
approval, workflow/mapping revision and privacy checks are unchanged.

This is **read-only**. It does not add interview campaigns, assessment publication,
stage moves or offer automation. Those remain implementation gaps, not deferred
manual tests. The Greenhouse verification panel says so.

## Operator setup, to do later

Store `GREENHOUSE_CLIENT_ID` and `GREENHOUSE_CLIENT_SECRET` in the API host's
secret manager, not browser code or an ordinary form. No values are included here.
Both are required. An incomplete configuration reports unavailable rather than
silently switching to another account.

This is a **single direct connection per API deployment**, suitable for the initial
employer pilot. It is not a tenant self-service credential vault. Do not put
different customers' credentials into the same pair or advertise arbitrary
multi-employer direct onboarding.

With direct credentials configured, connection discovery offers the direct
connection rather than discovering workspace-managed accounts. A platform
administrator must allocate it through the existing workflow's Greenhouse
verification controls, and the exact employer must separately confirm its account
reference. A credential being present proves neither account ownership nor
successful reads.

Credential rotation changes the opaque connection identity. Existing allocations
must be deliberately reviewed/replaced; no record mapping or employer approval is
silently carried over to the new credentials.

## Transport constraints

- Fixed OAuth origin `https://auth.greenhouse.io`; POST `/token` with the required
  `grant_type=client_credentials` query and Basic client authentication.
- Fixed resource origin `https://harvest.greenhouse.io`; GET only, Harvest v3.
- Only exact-ID jobs/candidates/applications or bounded application pages.
  Existing authenticated preview cursors remain necessary; no account-wide browser.
- No caller-supplied host, credential, authorization header, subject/user
  impersonation or write body.
- Redirect rejection, 10-second network timeouts, 64 KiB token-response bound and
  the existing 2 MB resource-response bound.
- Token reuse only inside the transport instance, with expiry margin and a
  single-flight exchange. No automatic retry on 401/403 or other failures.
- Runtime credential changes during exchange/read discard the result. Domain
  authorization must still be rechecked by the calling service before persistence.
- Generic errors only; no raw credential, access token or provider-body logging.
- No note, application move/reject/hire, email, offer or administrative endpoint.

## Official contract evidence

Verified on November 8, 2026:

- https://harvestdocs.greenhouse.io/reference/generate-token
- https://support.greenhouse.io/hc/en-us/articles/360029266032-Harvest-API-overview
- https://harvestdocs.greenhouse.io/reference/post_v3-notes.md
- https://harvestdocs.greenhouse.io/reference/post_v3-applications-id-move.md

The current note API is `POST /v3/notes`, with both candidate and application
anchors for an application-scoped note. Its request visibility uses `admin_only`,
`private` or `public`; response visibility uses different enum labels.
Do not reuse a candidate-level legacy endpoint.

The move API is `POST /v3/applications/{id}/move`, requires `from_stage_id`, and
can trigger configured stage rules and automated emails. A move approval must
cover those effects. A generic PATCH or a locally approved stage label is not
adequate execution authority.

## Evidence and acceptance boundary

Synthetic tests cover pinned URLs/methods, workspace independence, token expiry,
single-flight exchange, malformed/oversized responses, credential rotation,
revocation during I/O, cache invalidation and no automatic request replay.
No real Greenhouse credential, customer record, email or production service is
used by those fixtures.

The team still needs an owned Harvest v3 account to verify token exchange/scopes,
account ownership, exact-record and cursor shapes, application/profile intake,
revocation/rotation and externally hosted runtime behavior. These tests do not
complete the still-unimplemented Greenhouse interview/write-back workflow.

### Recorded development checks

November 8, 2026:

- Broader existing ATS/Zoho regression selection: **204/204 passing**.
- Final Greenhouse adapter/gateway/direct-transport selection after the streamed
  credential-revocation guard: **25/25 passing**, including nine direct-transport
  cases. This overlaps the broader selection; do not add the totals.
- API build, API typecheck and build/security guards passed.
- Frontend typecheck passed; targeted ESLint reported no errors.

The earlier 60/60 combined gate predates this direct-connection addition. These
focused checks are the new evidence; no new whole-project combined-gate pass or
live Greenhouse acceptance is claimed.
