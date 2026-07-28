# Security patterns — access control for candidate-bearing surfaces

This document is the written rule behind the `check:route-ownership` CI guard
(`scripts/check-route-ownership.mjs`, wired into `pnpm build`). It defines the
**default** every new route and table must follow so that tenant isolation and
recruiter-ownership are enforced by construction, not by memory.

The guard exists because tenant/ownership gates are easy to forget on a new
route, and a single ungated route that reads a `candidateId` / `jobId` /
`applicationId` / `campaignId` leaks cross-tenant data. The default is now
**mandatory**: a new id-bearing route with no recognized access-control marker
fails the build.

---

## Rule 1 — New candidate-bearing routes get an access-control gate by default

Any Express route in `src/routes/*.ts` whose path parameter **or** request body
references a `candidateId`, `jobId`, `applicationId`, or `campaignId` MUST carry
one of the recognized access-control markers within its handler span, or the
build fails naming the route.

Markers are split into two tiers (see `STRONG_TOKENS` / `WEAK_TOKENS` in the
guard for the authoritative lists).

**STRONG markers actually scope or gate the data — one is sufficient:**

- **Tenant scoping** — `getAllowedTenantIds` / `getDataScopeTenantIds` /
  `getAllowedTenantScope`, or the single-tenant `getTenantId` (returns the
  caller's own tenant id, used to scope the query). Every read/write must be
  filtered to the caller's allowed tenant subtree. Baseline for *all* staff routes.
- **Recruiter ownership ceiling** — `recruiterOwnsResource` /
  `recruiterCanAccessCandidate` / `getRecruiterAssignedJobIds` /
  `recruiterIsAssignedToJob` / `enforceOwnership`. Required wherever a recruiter
  (non-admin) must see only candidates tied to their assigned requisitions —
  tenant scope alone is not enough for that role.
- **Purpose-built gates** — `gateJobAccess`, `gateCandidate(Access)`,
  `gateRowByTenant`, `requireRequisitionWriteAccess`, `requireIcpWriteAccess`.
- **Agent surfaces** — `resolveAgentViewer` (read) / `requireAgentWriter`
  (write), which resolve the caller and compute the allowed tenant set.
- **Role / staff gates** — `requireRole` / `STAFF_ROLES` / `isStaff`.
- **Candidate self-path** — `resolveCandidateId` / `resolveCandidateSession`
  (from `lib/portal-auth`) / `resolveCandidateForRequest`: resolve the caller to
  their OWN candidate row (`users.id → candidates.userId`) — resolution and
  scoping in one step, so the route can only touch the caller's own candidate.
- **Interview capability cookie** — `requireInterviewSessionCookie`: the public
  interview room's path-scoped bearer.
- **Shared-secret gates** — `requireImportKey` (server-to-server import),
  `requireInboundSecret` (inbound webhooks).

**WEAK markers only resolve the caller — necessary but NOT sufficient:**

- `getAuthUserId` / `getCallerUser` / `resolveUser` / `ensureCandidateUser`.
  Knowing *who* is calling does not scope the data — a route can resolve the
  caller and still read another tenant's rows if it never scopes the query. A
  weak token alone therefore does **not** satisfy the guard; it must be paired
  with a strong marker. This closes the "authenticated but forgot to scope"
  false-negative class. (The residual — a strong marker present but applied to
  the wrong id — is statically intractable and stays with code review.)

A same-file helper counts as a marker **transitively**: if a helper's body
carries a STRONG token (or calls another safe helper), routes that call that
helper pass. This is why `resolveStaff`-style wrappers work — a wrapper that
resolves the caller *and* computes `getAllowedTenantIds` is safe, but one that
only calls `getAuthUserId` is not.

> Tenant/ownership rejections return **404, not 403** — do not reveal the
> existence of an out-of-scope resource.

## Rule 2 — Exemptions require a named justification constant

If a route legitimately must not be tenant/ownership scoped, it MUST declare an
explicit, named exemption rather than simply omitting the gate:

```ts
exemptFromOwnership(route, OWNERSHIP_EXEMPTION.TALENT_REDISCOVERY);
// or, for agency-wide reads:
readScopeExemption(NAMED_CONSTANT);
```

The named constant is the audit trail: it forces a reviewer to name *why* the
route is exempt. Silent omission is never acceptable.

### The ALLOWLIST (scanner blind spots)

Some routes are genuinely access-controlled by a mechanism the per-route span
scanner cannot see — a file-level `router.use(...)`, an opaque or HMAC-signed
capability token looked up in the DB, a public-by-design endpoint, or the
interview-room session-capability model. These live in the `ALLOWLIST` map in
the guard, each with a human-reviewed justification. Adding to the ALLOWLIST
requires review — it is an assertion that you checked the out-of-band gate.

### Known gaps (baseline debt)

Entries in the ALLOWLIST whose justification starts with `KNOWN GAP:` are
**genuine pre-existing gaps** surfaced by this guard that the earlier manual
audit did not cover. They are listed so the guard can act as a CI gate that
blocks *new* gaps while these are tracked as debt. The guard **re-prints them on
every run** (including green builds) so they never go quiet. Each carries the
concrete fix. When you fix one, add the real gate and **remove it from the
list** — do not add new `KNOWN GAP:` entries.

Current baseline (see the guard for the authoritative, live list):

| Route | Deficiency / fix |
| --- | --- |
| `agents.ts` — 6 `/jobs/:jobId/pipeline-*` + `/interview-direction` routes | No caller resolution / ownership gate. Apply the file's own `resolveAgentViewer` (GET) / `requireAgentWriter` (POST) + `recruiterOwnsResource(jobId)`. |
| `communication.ts` — `GET/POST /communication/events`, `GET /communication/ghosting-risks` | No tenant scoping (POST hardcodes `tenantId:"acme"`). Resolve the caller and scope by `getAllowedTenantIds`. |
| `learning.ts` — `GET /source-quality` | Cross-tenant aggregate with no staff/role gate. Apply the file's `getCallerUser` + `STAFF_ROLES` check. |

> **Scanner reachability limits (reported, not enforced).** The static scanner
> only reads `src/routes/*.ts`. Code paths that are **not** reached through an
> Express route registration are invisible to it: the background schedulers and
> the `ai_jobs` worker loop are driven by timers/queues, not HTTP routes, so
> their data access is out of scope for this guard and must be reviewed
> separately. Inbound **webhooks** *are* reachable (they are registered routes)
> and are covered — they gate via `requireInboundSecret`.

## Rule 3 — New tables need `tenant_id` + RLS, or a written exemption

Every new table that stores candidate / job / application / campaign data MUST
have a `tenant_id` column and Row-Level Security wired the same way as existing
tenant tables (FORCE RLS + the `app_tenant_in_scope` policy + grants + FKs).

- **Apply the `.sql` migration** — do **not** use `drizzle-kit push`. Push
  creates the table and FORCE RLS but *not* the policies/grants/FKs/checks, which
  leaves RLS in deny-all and every INSERT failing with a 500. Only the committed
  `.sql` migrations install the full security layer.
- A table that is intentionally global (cross-tenant, e.g. pooled sufficient
  statistics) must be documented as such where it is defined — a written
  exemption, the table equivalent of Rule 2's named constant.

  **Platform-operations tables (admin-pool only, no tenant reads).** A small set
  of tables are diagnostic/operational surfaces, not tenant data. They are NOT
  RLS-protected, are written fire-and-forget through the BYPASSRLS admin pool
  (`dbAdmin`), and are never read raw by a tenant-facing route. Any `tenant_id`
  column on them is informational metadata (whose request it was, if known), NOT
  an access-control key. Each is documented in its schema-file header:
  - `system_errors` — captured runtime crashes (self-hosted error tracking).
  - `stt_transcribe_events` — speech-to-text outcome metrics.
  - **`http_access_logs`** — the durable pino-http access-log sink (see
    `lib/db/src/schema/http-access-logs.ts` and `lib/http-access-log.ts`). The
    hosting platform offers no log drain, so each completed request is persisted
    here. It captures only method, the *registered route pattern* (never the raw
    URL or querystring — so ids/PII are not embedded), status code, response
    time, ip, resolved user/tenant id (nullable, metadata only), and the pino
    requestId. Request bodies, tokens, auth headers, and query strings are
    deliberately excluded. Rows are pruned after 30 days by the daily
    http-access-log retention scheduler. Exemption justification: it is a
    platform-ops diagnostic surface, not tenant-owned data, and no tenant-facing
    route ever reads it.
- If an unauthenticated route needs DB access, its prefix must be added to
  `BYPASS_PREFIXES`/`BYPASS_REGEXES` in `withTenantContext.ts` **and** the
  handler then owns all tenant scoping itself.

---

## For reviewers

- New id-bearing route? Confirm it has a Rule-1 marker or a Rule-2 named
  exemption. The build enforces this; do not disable the check to get green.
- Adding to `ALLOWLIST`? You are asserting you verified an out-of-band gate.
  Write the specific mechanism in the justification.
- New table? Confirm `tenant_id` + the full RLS layer via a `.sql` migration.
- See also `docs/recruiter-ownership-verification.md` for the recruiter-ceiling
  model this guard protects.
