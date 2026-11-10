# Lexy — Release / Fresh-Environment Checklist

Run through this list before pointing any new environment (staging, EU cell,
in-region cell, fresh prod) at real traffic. Items marked **HARD BLOCKER**
will cause user-visible breakage if skipped — do not launch without them.

Production hosting and its database are externally managed. This document is
an operator checklist, not permission to access production. Development results
and external acceptance must be recorded separately. See the
[consolidated six-stage closure list](qa/lexy-release-closure-2026-11-03.md),
[latest development verification](qa/assisted-release-verification-2026-11-03.md)
and [Zoho release handoff](zoho-release-checklist.md) for evidence and limits.

## 1. Database

- [ ] Postgres reachable from the API server (`SELECT 1` succeeds).
- [ ] All migrations applied in order: `lib/db/drizzle/0001…NNNN_*.sql`.
      Verify with `\dt` and spot-check the newest migration's columns/tables.
- [ ] **HARD BLOCKER**: `candidates.user_id` column exists and is populated
      for every candidate that has a portal account (migration `0012`).
      Without it, `getCandidateId()` returns null for every portal request
      and the candidate UI is bricked.

## 2. Secrets / environment variables

- [ ] `SESSION_SECRET` set, ≥ 32 chars, stable across replicas. The server
      refuses to issue tokens in production without it.
- [ ] `DATABASE_URL` set.
- [ ] `ENABLE_SELF_SERVE_BILLING` is **unset** or `false` unless this
      environment is opting into in-app Stripe checkout. Default go-to-market
      is sales-led; provisioning happens via `PATCH /tenants/:id/billing`
      (see §6 below). When unset, `/api/public/signup-checkout` returns 503
      `BILLING_DISABLED`.
- [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`,
      `STRIPE_PRICE_GROWTH` set **only** if `ENABLE_SELF_SERVE_BILLING=true`
      or sales plans to issue manual Stripe Checkout links.
- [ ] `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
      `AWS_S3_BUCKET` set.
- [ ] `DEV_AUTH_FALLBACK` is **unset** or `false` in production. If true in
      non-production, the legacy `demo_token_<userId>` format is accepted.
      The current verifier refuses that format in production regardless of
      the flag; do not enable it in a shared environment.

## 3. S3 bucket — **HARD BLOCKER**

The application does **not** configure bucket CORS on boot (by design — the
IAM role lacks `s3:PutBucketCORS`). Configure CORS on each upload bucket
once, via Terraform / IaC or the AWS console, before launch:

```json
[
  {
    "AllowedOrigins": [
      "https://app.lexy.ai",
      "https://us.lexy.ai",
      "https://in.lexy.ai",
      "https://eu.lexy.ai"
    ],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add every frontend origin that will be issuing presigned PUT/POSTs against
this bucket. Forgetting an origin manifests as silent "upload button does
nothing" bugs — the browser cancels the request before it reaches the API.

Bucket policy / IAM:
- [ ] Bucket has default SSE (AES256) enabled.
- [ ] App IAM role has `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`
      on `arn:aws:s3:::<bucket>/*` — and nothing else. No `PutBucketCORS`,
      no `*` on the bucket itself.
- [ ] Public access is **blocked** at the account and bucket level.
      All access is via presigned URLs.

## 4. Multi-region / data-residency

- [ ] `tenants.region` set on every tenant; matches the cell this database
      lives in.
- [ ] DNS for `us.lexy.ai`, `eu.lexy.ai`, `in.lexy.ai` (and any future cells)
      points at the correct cell's load balancer.
- [ ] Each cell's API has its own database; no cross-region replication of
      candidate PII.

## 5. Verification and acceptance — **HARD BLOCKER**

- [ ] Retain completed development verification reports and review all failures
      and follow-up corrections. Do not automatically rerun expensive combined
      checks when the relevant evidence is already current.
- [ ] Verify externally managed schema/configuration through the deployment
      owner's approved process before release.
- [ ] Record authorized Linx and calendar/meeting acceptance separately from
      synthetic development checks. Zoho reconnection/live campaign acceptance
      remains deferred until the employer is ready.
- [ ] Do not count pending or simulated provider operations as live success.

For a new, authorized development verification run:

```sh
pnpm test:assisted-baseline
```

This suite is not production acceptance or proof of every user journey.
Native offer-session checks require separate independently verified development
database targeting; see [the session and recovery guide](qa/offer-session-role-and-recovery-2026-11-03.md).

### Legacy mutating smoke: isolated development only

`artifacts/api-server/scripts/smoke-critical-journeys.mjs` is **not** the
release gate. It can create durable accounts and business records, attempt
billing/email/automation, and does not automatically clean up. Its
best-effort/optional branches and absent admin token can skip major paths;
exit zero does not prove those paths passed.

It now refuses production runtimes and external hosts before sending requests.
An operator who explicitly needs it must first verify that the local API uses
isolated development data and safe backing services, then supply all three:
`SMOKE_ALLOW_MUTATIONS=true`, an explicit loopback `SMOKE_BASE_URL`, and
`SMOKE_CONFIRMED_ORIGIN` matching that URL's normalized origin, including its
non-default port. No default target is used and HTTP redirects are refused.
Loopback targeting alone does not prove database or provider isolation.

Do not extract session credentials from browser storage or paste them into
chat. Use native authenticated sessions for the supported checks. Testing this
legacy tool's refusal requires no application credentials or business writes:

```sh
pnpm test:smoke-target-guard
```

## 6. Billing (sales-led / manual)

Default GTM is sales-led. Stripe self-serve checkout stays OFF unless
`ENABLE_SELF_SERVE_BILLING=true` is set explicitly (see §2). Provisioning
flow once a deal is signed:

1. Platform admin creates the tenant + first tenant_admin via the existing
   `POST /tenants` flow (or `POST /tenants/:id/members` for invites).
2. Platform admin records the commercial terms with **a single call**:
   ```bash
   curl -X PATCH https://api.<env>.lexy.ai/api/tenants/<tenantId>/billing \
     -H "Authorization: Bearer <platform_admin_token>" \
     -H "Content-Type: application/json" \
     -d '{
       "plan":            "growth",
       "status":          "active",
       "billingTerm":     "annual",
       "paidThroughAt":   "2027-05-16T00:00:00Z",
       "billingNotes":    "PO #4471 — AP: ap@customer.com — owner: jane@lexy.ai"
     }'
   ```
3. The tenant immediately sees "Paid through 2027-05-16 — managed by your
   account team" on `/recruiter/subscription` and `plan-enforcement`
   honours the new expiry.
4. To suspend a non-paying tenant, PATCH with `{"status":"suspended"}` or
   set `paidThroughAt` to a past date. Either is sufficient.
5. `billing_notes` is platform_admin-only. It is **never** returned to
   tenant_admin or recruiter callers (verified in `mapTenant` and
   `/billing/me/subscriptions`).

Renewal checklist (manual, calendar-driven until volume justifies a
recurring-billing integration):
- [ ] 30 days before `paid_through_at`: AE notified via calendar / CRM.
- [ ] On invoice settlement: PATCH `paidThroughAt` forward by the contract
      term. Append the new PO # to `billingNotes`.
- [ ] On non-payment past grace: PATCH `status='suspended'`. The tenant's
      next request hits the plan-expired gate.

## 7. Observability

- [ ] `/healthz` returns 200 and reports DB + Stripe + S3 reachability.
- [ ] Logs are flowing to the central sink.
- [ ] Error tracker (Sentry / equivalent) is receiving events from a
      deliberate test error.

## 8. Compliance (EEO / GDPR — see migration 0011)

- [ ] `candidate_demographics` table exists and is read **only** by
      `/analytics/diversity` (k-anonymity ≥ 5 enforced server-side).
- [ ] Recruiter candidate-detail responses do not include any demographic
      fields. Verify with the smoke script's recruiter step.
- [ ] EU cell: consent copy renders GDPR Article 9 boilerplate;
      US cell: OFCCP/EEO boilerplate.

---

Owner: whoever is doing the release. Sign and date below.

| Env  | Date       | Signed off by | Smoke exit code |
|------|------------|---------------|-----------------|
|      |            |               |                 |
