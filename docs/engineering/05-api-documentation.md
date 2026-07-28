# Lexy — API Documentation

> Engineering documentation set · Doc 5 of 9
> The HTTP surface of `@workspace/api-server`. All routes are mounted under
> `/api`. Validation is Zod (`@workspace/api-zod`); persistence is Drizzle
> (`@workspace/db`).

## 1. Authentication

| Mechanism | Where used | How it works |
| --- | --- | --- |
| **Bearer token** (primary) | All recruiter/admin/candidate API calls | HMAC-SHA256-signed token of the form `v2.<payload>.<signature>`, resolved by the `resolveUser` middleware. The frontend stores it in `localStorage` and `apiFetch` attaches it. |
| **Session cookie** | Candidate live-interview flow | `lexy_interview_session`, validated by `requireInterviewSessionCookie`; binds the session to a browser fingerprint + HMAC. Path-scoped and cleared by `/end`. |
| **URL tokens** | Invites & one-click replies | `/api/invites/:token`, `/api/staff-invites/:token`, `/api/outreach/reply/:token`. |

**Critical rule — header presence is not authentication.** A handler must resolve
the caller (`getAuthUserId` + lookup) and **401 a null user before any role
check**. Don't trust a header just because it's present.

## 2. Authorization & tenant scoping

Every authenticated `/api/*` request passes through **`withTenantContext`** before
the handler:

1. Acquire a DB connection, `SET ROLE lexy_app`.
2. Set GUCs `app.current_tenant_id` and `app.allowed_tenant_ids`.
3. Postgres **RLS** policies then restrict visibility on `candidates`,
   `applications`, `interview_sessions`, etc.

`getAllowedTenantIds(user)` resolves the caller's scope:

| Role | Scope |
| --- | --- |
| `platform_admin` | `null` → sees everything (cross-tenant). |
| `tenant_admin` | own tenant **+ all descendants** (recursive CTE subtree). |
| `recruiter`, `hiring_manager`, `interviewer` | tenant-scoped (per role). |
| candidate | candidate portal only. |

`STAFF_ROLES` = `platform_admin, tenant_admin, recruiter, hiring_manager,
interviewer`. **`getAllowedTenantIds` is not a staff gate** — candidates also
have a non-null `tenantId`, so staff-only routes need an explicit `STAFF_ROLES`
allowlist. Any caller-supplied `jobId`/`candidateId` must be validated against the
allowed set **before** use.

## 3. Conventions

- **Base path:** all endpoints below are relative to `/api`.
- **Validation:** request bodies are whitelisted by Zod — **unknown body keys are
  silently stripped**. A field your handler reads must be in the route's schema.
- **Errors:** prefer explicit status codes; `409 email_match` for candidate dedup
  collisions, `401` for unauthenticated, `403` for out-of-scope tenant access.
- **Async work:** long-running operations enqueue an `ai_jobs` row and return
  quickly; the UI infers "running" from stage + null result + recent `updatedAt`.
- **Rate limiting:** there is **no global, API-wide rate limit**. Limiting is
  applied **selectively** via `middlewares/rateLimit.ts` to abuse-prone or
  unauthenticated endpoints only — e.g. login, candidate registration, password
  reset/forgot, talent-pool apply, invite-accept, and interview start/step-up
  verification — keyed per IP / per email / per session (typical windows: a
  handful of requests per minute or per hour). The main authenticated CRUD routes
  are **not** rate-limited today. **Do not** assume the platform will protect you
  from a runaway integration: if you're building an automated client, throttle on
  your side, and don't poll authenticated endpoints aggressively.

> ⚠️ **`GET /candidates` quirk (read before you build on it).** This endpoint
> returns the entire candidate bench in a single payload, **capped at 1000 rows**,
> and it **ignores `limit`** (and offset-style pagination) entirely. Two failure
> modes for the unwary: (1) you receive a much larger response than expected and
> assume pagination is happening when it isn't; (2) on a tenant with >1000
> candidates you **silently get a truncated list** with no error and no "next
> page" — code that treats the result as complete will quietly drop candidates.
> *Why it's like this:* the recruiter UI loads and filters the bench client-side,
> so the endpoint was built to hand back the whole working set at once rather than
> page it. If you need guaranteed-complete results above the cap, use
> `POST /candidates/nl-search` / a scoped query rather than relying on this list.

## 4. Route inventory by domain

> Representative endpoints per domain. Handlers live in
> `artifacts/api-server/src/routes/*`; this is the map, the code is the contract.

### Auth — `auth.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/login` | Recruiter/admin login (email + password). |
| POST | `/auth/candidate-login` | Candidate portal login. |
| POST | `/auth/register` | Candidate self-registration. |
| GET | `/auth/me` | Current user profile from the token. |

### Sourcing — `sourcing.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/sourcing/search` | Multi-source candidate search (internal → github/pdl/serp). Internal-first. |
| POST | `/sourcing/nl-search` | Natural-language candidate sourcing. |
| GET | `/sourcing/candidates` | List saved sourced candidates for a tenant. |

> Providers run behind the adapter registry (`lib/sourcing-providers.ts`) with
> per-kind timeouts; a failed/disabled provider returns a `skipped` reason rather
> than failing the whole search.

### Candidates — `candidates.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/candidates` | Candidate pool (tenant/platform scoped). ⚠️ **Known limitation:** returns the *whole* bench in one response, hard-capped at **1000 rows**, and **ignores the `limit` query param**. See note below. |
| POST | `/candidates/nl-search` | AI search over the candidate pool. |
| GET | `/candidates/:id` | Single candidate profile. |
| POST | `/candidates/parse-cv` | Stateless CV text extraction. |

### Jobs — `jobs.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/jobs` | List jobs (tenant-scoped). |
| POST | `/jobs` | Create job / work order. |
| POST | `/jobs/generate-jd` | AI-generate a job description. |
| PATCH | `/jobs/:id/platform-recommendations` | Toggle AI cross-tenant recommendation consent. |

### Pipeline — `pipeline.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/jobs/:jobId/pipeline` | Pipeline config + recent runs. |
| POST | `/jobs/:jobId/pipeline/run` | Trigger async pipeline run (ICP→Sourcing→…). |
| GET | `/jobs/:jobId/pipeline-stages` | Kanban data (applications + sourced leads). |
| PATCH | `/sourced-candidates/:id` | Advance candidate stage (drag-and-drop). |

### Interviews — `interviews.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/interviews/plans` | Create an AI interview plan for a job. |
| POST | `/interviews/sessions` | Create a session + issue a candidate invite. |
| POST | `/interviews/transcribe` | Real-time STT for audio chunks (Azure/Whisper). |
| POST | `/interviews/:id/converse` | Real-time AI interview turn (LLM + TTS). |

> Entering the `verification` stage auto-runs the Verification Agent for **all**
> candidates (sourced + applied). Interview `/end` AI-grades each answer once and
> advances the application stage.

### Outreach — `outreach.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/outreach/campaigns` | Create an automated outreach campaign. |
| POST | `/outreach/messages/:id/approve` | Approve an AI-drafted first-touch email. |
| GET | `/outreach/inbox` | Recruiter inbox of candidate replies. |
| GET/POST | `/outreach/reply/:token` | One-click candidate reply (self-decline / interest). |

> Default is **approval-required**: drafts wait for a recruiter unless autopilot is
> explicitly enabled. Draft status is guarded inside the UPDATE predicate to
> prevent double-sends.

### Intelligence — `intelligence.ts`
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/intelligence` | Candidate fit scores + hire probabilities. **Requires the bearer token** — a missing token 401s and silently dumps every candidate into "Unmatched." |
| GET | `/intelligence/policy` | Manage tenant AI decision thresholds. |
| POST | `/intelligence/:jobId/:candidateId/decide` | AI next-best-action recommendation. |

### Admin / Platform
| File | Method | Path | Purpose |
| --- | --- | --- | --- |
| `tenants.ts` | POST | `/tenants` | Provision a new tenant (`platform_admin`). |
| `tenants.ts` | PATCH | `/tenants/:id/billing` | Manual billing override (status / paidThroughAt). |
| `system-errors.ts` | GET | `/system-errors` | Diagnostic dashboard for crashes/500s. |
| `audit.ts` | GET | `/audit` | SOC2 audit trail of recruiter/AI actions. |

### Subscriptions & Billing
| File | Method | Path | Purpose |
| --- | --- | --- | --- |
| `plans.ts` | GET | `/plans/catalog` | Public plan pricing + limits. |
| `plans.ts` | POST | `/plans/start-trial` | Email-verified self-serve demo signup. |
| `billing.ts` | POST | `/billing/checkout` | Stripe Checkout session for upgrade. |

### Connection Engine (feature-flagged additive module)
Enabled via `ENABLE_CONNECTION_ENGINE` / `ENABLE_CANDIDATE_CONNECTION_ENGINE`.
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/connection-score/:candidateId` | Employer-side engagement score (0–100). |
| GET | `/connection-events/:candidateId` | Underlying engagement events. |
| POST | `/connection-event` | Record an engagement event. |
| POST | `/connection-score/recalculate` | Recompute a connection score. |

## 5. Discovering the rest

This is the high-traffic surface, not an exhaustive OpenAPI dump. The
authoritative spec is `@workspace/api-spec` (Orval), from which
`@workspace/api-client-react` hooks are generated. To find any endpoint:

```bash
rg "router\.(get|post|patch|put|delete)\(" artifacts/api-server/src/routes
```

When you add or change an endpoint: update the Zod schema (`@workspace/api-zod`),
regenerate the client (`@workspace/api-spec` codegen), and keep the auth/tenant
gating rules in §2 — they are not optional.
