# Real staff-session offer access — 2026-11-03

## Result

**PASS in verified development.** This is real password/cookie authentication,
native HTTP authorization, database state and rendered UI evidence, not the
previous synthetic-response browser test.

The opt-in runner creates an isolated employer, two active tenant-admin staff
accounts and 26 synthetic candidate/application/workflow rows under one job.
Both staff are explicitly assigned offer-routing roles. All human-decision
evidence is marked test-only. There are no controlled offer terms or deliveries.

The test uses two independent Chromium browser contexts:

1. Each account logs in through the native `POST /api/auth/login` endpoint with
   its own generated password and receives its own real HttpOnly session cookie.
   `GET /api/auth/me` must identify the expected fixture account.
2. Both screens load the real offer inbox, including its second cursor page and
   a selected second-page detail. Inbox and authentication responses are **not**
   intercepted or substituted.
3. The retained account suspends the other account using the existing
   `PATCH /api/users/:userId` staff-management endpoint.
4. The revoked account's original cookie is reused for first-page, cursor-page
   and detail HTTP reads. Every request must return 401 or 403, with no list,
   detail entry or private candidate name in the response.
5. Without reloading the revoked browser or changing its query cache, ordinary
   inbox/detail polling must hide its existing private rows and detail panel.
6. The other staff account's same reads must remain 200. Its screen can refresh,
   load the later page and retain the selected detail, and its session identity
   must remain the retained account.
7. No workflow gains a controlled offer; no outcomes or fee entries are created.
   Unexpected browser API writes are blocked and fail the check. The only
   allowed browser writes are fixture logins and the exact fixture suspension.

The app's common suspended-account handling returned 403 before the individual
inbox handler's 401 branch. Both are legitimate access-denied statuses; the
test requires denial **and** absence of resource data, plus the authorized
positive control. Initial harness-only failures were a missing bundled Chrome
version and an overly specific 401 expectation; cleanup succeeded in both cases.
The completed run used installed Chromium and passed the full scenario.

## Safety and cleanup

Before any fixture write, the runner requires an explicit fingerprint
independently obtained through the development database handle. Both application
and control ORM handles must match it. Missing proof and wrong proof were each
verified to fail before fixture creation. `NODE_ENV=production` is refused.

The browser uses the existing **loopback development preview gateway** only.
External browser requests are blocked. It does not open a production URL,
reconnect Zoho, send candidate messages, call providers, or modify LLM settings.
No application authorization or UI behavior was changed to make the test pass.

Passwords and session tokens stay in memory and are not printed or saved to
fixture manifests. Both browser contexts are closed. A `finally` cleanup removes
the fixture's business records and accounts in one tenant-scoped transaction and
checks that they are absent. Existing security/access-log retention is not
rewritten to remove test activity.

An independent read through the explicit development database handle confirmed
zero remaining test-namespace tenants, staff, jobs, candidates, applications,
workflows and journeys after the runs. As with ordinary process-level cleanup,
`finally` is not a guarantee against an OS-level force kill or machine failure.

## Running it again

Services must already be running locally. No service restart or key change is
needed. Obtain the identity through the **explicit development** SQL handle:

```sql
SELECT md5(current_database() || ':' || system_identifier::text)
  AS development_fingerprint
FROM pg_control_system();
```

Then run:

```sh
pnpm run test:offer-session-access --development-fingerprint=<verified-development-fingerprint>
```

Do not obtain the expected identity from an unverified application connection:
that would merely compare the connection with itself. This runner writes
disposable fixture records and is deliberately not added to the automatic,
noninteractive combined assisted baseline.

Reusable code:

- `artifacts/api-server/scripts/offer-session-fixture.ts`
- `artifacts/api-server/scripts/check-offer-session-access.ts`
- `artifacts/lexy/scripts/check-offer-session-access.mjs`

Ignored local evidence appears under
`generated-artifacts/offer-session-access/<fixture-prefix>/`: before revocation,
revoked session hidden, and authorized session retained. Screenshots contain
synthetic data only.

Changed-source ESLint, formatting, runner syntax and patch whitespace checks
passed. No full unrelated baseline rerun was needed.

## Limits

This verifies **staff suspension within the same employer**, using tenant-admin
accounts and explicit offer-routing assignments. It does not claim production
cookie/proxy verification, the login form's UI, cross-customer isolation,
active-account role downgrades or requisition reassignment. Those are different
authorization paths; a passing suspension scenario is not proof of them.

Subsequent active-role and interrupted-run coverage is documented in
[Active-role access and fixture recovery](offer-session-role-and-recovery-2026-11-03.md).
That follow-up extends the reusable runner; the suspension evidence above
retains its original scope.
