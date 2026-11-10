# Zoho Recruit integration

## Current status

The account-independent **read-only record adapter** is implemented in
`artifacts/api-server/src/lib/ats-connectors/zoho-recruit.ts` with isolated
contract tests. It implements the shared `AtsRecordReader` interface.

The direct employer OAuth connection flow is implemented separately from
Replit's catalog connector. Live authorization reached employer review; real-record
import and job-scoped application-search compatibility remain **unverified**.
Individual reviewed imports are available in development. No scheduled sync,
bulk interview invitations, ATS stage changes, offers or recruiting emails
are enabled by the connection screen. Greenhouse and Lexy's
native hiring flow are unchanged.

## Direct account authorization

Open **Settings → Manage ATS connections → Zoho Recruit** (`/settings/ats`).
Only an active `tenant_admin` of the exact employer can authorize and confirm
the account. Agency and platform visibility alone are insufficient. This
initial implementation connects the employer administrator's own tenant, not
an arbitrary child selected by the browser.

Server configuration:
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`: secure project secrets.
- `ZOHO_REDIRECT_URI`: explicit HTTPS API URL ending in
  `/api/zoho-recruit/callback`.
- `ZOHO_SETTINGS_URL`: explicit HTTPS frontend URL ending in `/settings/ats`.
- `SESSION_SECRET`: required for authenticated token encryption.
- `ZOHO_DATA_CENTER`: `us` for `recruit.zoho.com`, or `in` for
  `recruit.zoho.in`. If omitted, the earlier India configuration remains the
  default. Use credentials for the selected data center.

Register the exact `ZOHO_REDIRECT_URI` in the Zoho API Console as an authorized
redirect URI. **Do not use** `https://replit.com/connectors/oauth/callback` for
this direct flow. That callback belongs to the separate Replit connector.
Development configuration does not configure external production hosting.

The deployment explicitly selects either US (`accounts.zoho.com`,
`www.zohoapis.com`) or India (`accounts.zoho.in`, `www.zohoapis.in`). The current
development pilot uses US, matching the user's Recruit account. Callback
`location` and `accounts-server` must both match the configured region before
token exchange; the token response must match its fixed API origin as well.
No browser-supplied or provider-supplied host can redirect credentials. Changing
the region changes the connection fingerprint and requires fresh consent.
There is no automatic regional fallback or retry of authorization codes.

Organization metadata specifically uses the documented product endpoint
`https://recruit.zoho.com/recruit/v2/org` (or `recruit.zoho.in` for India).
Do not construct this organization endpoint from the token's `api_domain`:
the corresponding `www.zohoapis.*` organization route returns 404. Both token
API-domain validation and the separate fixed organization origin are retained.

Authorization requests the three documented candidate/jobopening/application
READ scopes and `ZohoRecruit.org.all` for organization metadata. The code only
exchanges the authorization code and GETs organization metadata. It never
reads a candidate or job during connection. Current scope spelling and regional
metadata behavior still need live acceptance.

OAuth state is random, hashed, ten-minute, single-use and bound to an httpOnly,
Secure, SameSite=Lax browser cookie, the signed-in administrator, employer and
application configuration. The callback requires the same active admin session.
Tokens are encrypted with embedded employer/account context and never returned
to the browser. A saved grant remains `review_required` until its authorizing
employer administrator reviews the displayed company and explicitly confirms.
Changing credentials/configuration invalidates the local connection fingerprint.

The organization response's `primary_userid` is only a conservative account
reference, **not an immutable organization ID or independent proof of employer
ownership**. Duplicate references across employers are refused; the employer
attestation is still required. Import integration must verify a stable real
organization identity and exact module/record permissions before using grants.

Local disconnect deletes stored tokens and invalidates pending callbacks.
It does not revoke the provider's consent or delete existing imported data.
An existing grant must be disconnected explicitly before account replacement.
No automatic token refresh, retries, data reads or shared grant consumers are
enabled in this milestone.

Schema migration: `lib/db/drizzle/0099_zoho_recruit_accounts.sql`. The custody
table has forced RLS, no request-role policies, and no PUBLIC/`lexy_app` grants.
Applied to the development database only. External production requires the
team's normal reviewed migration process; no startup DDL is added.

## Read contract

Provider key: `zoho_recruit` (not `zoho`, Zoho CRM, or Greenhouse).
Account binding is employer-specific and case-sensitive.

GET only:
- `/recruit/v2/Job_Openings/{record_id}`
- `/recruit/v2/Candidates/{record_id}`
- `/recruit/v2/Applications/{record_id}`

IDs remain decimal strings, including values beyond JavaScript's safe integer
range. A successful exact-record response must have one matching `data` entry.
The application must have matching `Candidate_Name.id` and
`Job_Opening_Name.id` lookups. Missing/customized fields are a failed verification,
not permission to infer a relationship from names or historical records.
The normalized result contains only record IDs; no status is interpreted as a
Lexy hiring decision, offer approval or employment.

The injected connection must enforce a current employer grant before each read
and after all reads. It must pin the verified regional Recruit origin, deny
redirects, bound request/response size and time, and never accept credentials,
origins or arbitrary paths from browser input.

## Remaining connection work

1. Complete live direct OAuth and verify actual Recruit scopes and selected-region routing.
   CRM-only authorization is insufficient. Official pages use inconsistent
   capitalization; synthetic tests cannot establish granted account permissions.
2. Verify stable remote organization identity alongside employer confirmation.
3. Check module/field metadata and an exact application response from a test
   organization before claiming the standard lookup contract is live-compatible.
4. Wire the exact-record regional transport to the existing ATS mapping
   verifier for application/job/candidate relationships. The manual intake
   path below uses server-held refresh custody but does not verify a mapped
   application or enroll a candidate in a requisition.
5. Extend the manual, exact-ID job/candidate intake below with separately
   approved recurring refresh only after live field and ownership checks;
   retain deduplication, erasure/privacy fences and failure reporting.
6. Run one real-account read/import acceptance test. External stage writes and
   controlled offer handoff are separate, human-authorized capabilities.

## Job-scoped application review

The read-only employer-admin review in ATS settings accepts an exact Zoho
job-opening ID, verifies the opening, then searches the Applications module
with documented `Job_Opening_Name` criteria on the fixed regional Recruit host.
Each page is limited to 25 records and returns only exact string
application/candidate IDs. Missing candidate/job lookup fields, cross-job
records, duplicate IDs and malformed envelopes fail closed. It neither
imports applications nor sends invitations or changes stages.

Zoho application search requires `ZohoRecruit.search.READ` in addition to
module read scopes. This changes the connection fingerprint; existing employer
admins must disconnect locally, reauthorize and reconfirm the account.
Previously imported Lexy records remain. A real Recruit account must verify
that the permission and job-lookup search criterion actually work. Associated
candidates alone are not proof of an application. A later interview campaign
needs an approved job-scoped snapshot across all pages, contact/eligibility
checks, retry-safe deduped invitations, and human advancement review.

## Manual read-access diagnostics

After employer confirmation, an exact-employer administrator can explicitly
run **Check read access** from ATS settings. The check refreshes the server-held
credential, rechecks the reviewed organization reference, and issues one
ID-only sample request per module (`Job_Openings`, `Candidates`, `Applications`).
The requests use the documented regional Recruit product host, `fields=id`,
`page=1`, `per_page=1`, bounded response size/time and no redirects or retries.
No record fields or identifiers are returned to the browser, logged or saved.

Each module reports readable, accepted-but-empty, or unavailable with a fixed
permission/support/request failure category. Empty does not prove zero account
records; read success does not prove application lookup compatibility. The
dated result is an ephemeral browser observation, not durable sync health or
import approval. It clears on connection/identity changes, page navigation,
new checks and after five minutes.

The requester and original authorizing admin must remain active administrators
of the exact employer. Local connection revision, credential binding and
approval are rechecked across every provider boundary, including after the
last module read. Disconnect, replacement, suspension, changed organization
reference or invalid encrypted custody abort the check. Revoked access tokens
abort rather than returning fabricated empty results. No imported rows, stage
changes, offers, emails or scheduler enablement occur.

This endpoint is `POST /api/zoho-recruit/account/check-access`, with an explicit
`{ revision, confirm: true }` body. It does not prove the existing exact-record
adapter or reviewed-import workflow has been exercised live.

## Reviewed, manual record intake

An exact-employer administrator can now enter one specific numeric Zoho Recruit
job-opening or candidate ID in ATS settings, preview its limited fields and
explicitly confirm an import. The server requests the exact record from the
fixed regional Recruit host with an allowlist of fields. The preview is
short-lived and bound to the administrator, employer, connection revision,
account and record ID. Confirmation re-reads the provider record and rejects
changed details. It checks the current grant, original authorizer and requesting
administrator throughout the remote reads and locks the grant/administrators
before a local write.

Jobs become **draft Lexy work orders**, with private provider-identity
provenance. Candidates enter the employer's tenant pool **without application,
stage, outreach or portal login**. A matching Lexy candidate requires an
explicit identity-link confirmation; no existing profile is overwritten.
Ambiguous matches, known privacy exclusions, erased identities, opted-out
provider candidates and changed account context fail closed. Already imported
IDs return the same local record instead of creating duplicates. No automatic
sync, account-wide browsing, external writes or offers are enabled.

The additive `0100_zoho_imported_jobs.sql` migration must be applied to each
target database through the normal reviewed migration process **before using
imports there**. It has been applied to the workspace development database,
not the externally hosted production database. Preview/confirm endpoints are
`POST /api/zoho-recruit/imports/preview` and `/confirm`. No actual Zoho record
import has been certified against a real account yet; the ID-only read
diagnostic and synthetic contract tests do not establish live field compatibility.

## Official references checked

- https://www.zoho.com/recruit/developer-guide/apiv2/get-records.html
  — exact record GET, `data` envelope, long string IDs and module read scopes.
- https://www.zoho.com/recruit/developer-guide/apiv2/get-hiring-pipeline-transition-details-for-an-application.html
  — Applications module and standard candidate/job lookup names. History-entry
  IDs are **not** treated as application IDs.
- https://www.zoho.com/recruit/developer-guide/apiv2/access-refresh.html
  — regional token exchange and fixed API-domain verification.
- https://www.zoho.com/recruit/developer-guide/apiv2/refresh.html
  — regional refresh-token exchange; access tokens remain server-only.
- https://www.zoho.com/recruit/developer-guide/apiv2/get-org-data.html
  — organization metadata; the documented sample has a primary user reference,
  not an established immutable organization identifier.

The real account's metadata and exact-record payload remain to be confirmed;
these contract tests are not evidence of live provider acceptance.
