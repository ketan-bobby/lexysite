# Lexy — Release / Fresh-Environment Checklist

Run through this list before pointing any new environment (staging, EU cell,
in-region cell, fresh prod) at real traffic. Items marked **HARD BLOCKER**
will cause user-visible breakage if skipped — do not launch without them.

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
      prod, the legacy `demo_token_<userId>` format is accepted and every
      user is impersonable.

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

## 5. Smoke pass — **HARD BLOCKER**

Run the automated smoke script against the freshly provisioned environment:

```bash
SMOKE_BASE_URL=https://api.<env>.lexy.ai \
SMOKE_EMAIL=smoke+<env>@lexy.ai \
SMOKE_PASSWORD='<strong-pw>' \
SMOKE_STAFF_TOKEN='<bearer-token-of-any-tenant_admin-or-recruiter-in-this-env>' \
SMOKE_REQUIRE_SHADOW_GUARD=true \
  node artifacts/api-server/scripts/smoke-critical-journeys.mjs
```

`SMOKE_STAFF_TOKEN` is mandatory on release runs — the script will refuse to
exit 0 without it when `SMOKE_REQUIRE_SHADOW_GUARD=true`. Obtain it by
logging into the target environment as a tenant_admin in a browser, opening
DevTools → Application → Local Storage, and copying the `lexy.session.token`
value. The script uses it only to assert that staff tokens are correctly
REFUSED by `/portal/*` (the auth-shadowing regression closed by migration
0012); it does not mutate any data with that token.

The script must exit 0. It exercises:

1. Tenant + admin signup
2. Stripe checkout session creation (only when `ENABLE_SELF_SERVE_BILLING=true`;
   otherwise this step is expected to warn `billing not configured`)
3. Recruiter invite generation and acceptance
4. Job posting creation
5. Public candidate application against that job
6. Candidate portal session resolves to the right candidate (auth-shadowing
   regression test for migration 0012)
7. Interview kickoff
8. Hire decision

If any step fails, **do not launch this environment**.

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
