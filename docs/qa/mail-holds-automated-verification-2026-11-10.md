# Mail Holds — repeatable browser and real-session verification

Scope: automated development checks only. No production access, new schema,
runtime authorization change, provider/configuration change or candidate email.

## Results

- **5/5 repeatable browser scenarios passed.** The real Mail Holds page,
  application layout/providers and generated API client run in an isolated
  temporary Vite server. Authentication/queue/review responses are synthetic.
  There is no backend proxy; server-side `/api` fallback refuses requests.
  Browser interception blocks external requests and unexpected mutations.
- The suite is a **required `mail-holds-browser` group** in the assisted baseline,
  not just a one-time interactive test. It covers explicit decision/reference/
  acknowledgement and exact POST contract; success reset/refetch; stale 409;
  direct read 403; mutation 403 followed by read 401; fresh authorized recovery
  without resurrecting the old form; cursor navigation; version drift; and
  identity changes without displaying the prior account's cached holds.
- **Nine real HTTP denial scenarios passed: 27 denied resource requests.**
  Native password login issues cookies for two isolated platform-admin accounts.
  These cookies, not intercepted responses or forged request identities, reach
  the running local application's full middleware/router/database stack.
  Each denial scenario checks first-page GET, cursor GET and review POST.
- Scenarios: absent cookie, malformed cookie, account suspension, role downgrade
  to tenant admin/recruiter admin/recruiter/candidate, cookie removed after
  logout, and deleted identity reusing its original cookie.
- Every negative scenario leaves the review-audit count unchanged and returns
  no fixture operation/candidate data. An independent unchanged admin cookie
  still reads and reviews successfully after each denial.
- Positive reviews preserve `pending` status and null send time. No provider,
  retry, send-release or delivery mutation occurs.
- Wrong development fingerprint was refused without creating/changing fixture
  journals. Exact cleanup and repeated completed-journal recovery passed,
  checking absence of the owned tenant, users, candidate, mail event and review
  audits. No prefix-wide cleanup is used.
- New files passed targeted lint; frontend strict typecheck passed.

This is separate evidence from the earlier 58 focused email tests. That result
is not a new combined-run invocation and has not been relabelled.

## Important revocation boundary

Existing authentication uses stateless signed tokens. Logout clears the browser
cookie; it **does not revoke an already copied valid token at the server**.
The test explicitly confirms that distinction, then proves the original cookie
is denied when its account is deleted. Suspension and role downgrades also take
effect against the original cookie's old admin claim.

These results prove current account/role enforcement, invalid/missing-cookie
denial and account removal. They do **not** prove per-session server-side token
revocation, stolen-token invalidation on logout, browser cookie-policy coverage,
production request roles or real provider acceptance. No broader auth migration
was made as part of this testing request.

## Run browser regression

```sh
pnpm --filter @workspace/lexy run test:mail-holds-browser
```

Requires installed Chromium/Puppeteer and existing dependencies. Uses no live
application or database, and can run in the ordinary assisted baseline.

## Run native cookie-session checks

Keep the native development frontend/API workflows running. Independently obtain
the database fingerprint through the explicit **development** SQL handle:

```sql
SELECT md5(current_database() || ':' || system_identifier::text) AS fingerprint
FROM pg_control_system();
```

Then replace the placeholder:

```sh
pnpm run test:mail-hold-session-access --development-fingerprint=YOUR_VERIFIED_DEVELOPMENT_FINGERPRINT
```

The runner refuses production mode and verifies application/admin and control
database identities before fixture writes. It uses only the loopback gateway.
Login must identify the fixture user, proving the local HTTP service can see the
verified fixture. This committed native test is **opt-in**, not an unguarded
database-mutating step in the ordinary baseline.

Credentials/cookies remain in memory. A private, non-credential journal under
`generated-artifacts/mail-hold-session/` records exact canonical fixture identity,
database fingerprint, ownership and owner PID before writes. Successful cleanup
marks the journal complete. Interruptions attempt cleanup; a force kill can
require recovery:

```sh
pnpm run test:mail-hold-session-access --development-fingerprint=YOUR_VERIFIED_DEVELOPMENT_FINGERPRINT --cleanup=EXACT_RUN_UUID
```

Recover only an inspected exact journal. Recovery rejects altered identity,
another live owner or unexpected fixture contents. Missing/uncertain ownership
requires review; it is not permission to scan/delete similarly named records.
Ordinary request/security telemetry retains its normal retention policy.
