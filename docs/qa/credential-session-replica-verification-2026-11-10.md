# Credential changes and replica/restart revocation — development verification

This is the latest authentication increment. It supersedes the earlier
handover's pending account-wide password-change and multi-process proof items.
Production, external provider configuration and stabilized AI settings were
not changed.

## Delivered behavior

1. A password reset or hash change atomically rotates an opaque account
   credential epoch. All previously issued sessions for that account are
   rejected, whether presented through cookies or Authorization headers.
2. Ordinary logout still revokes only its selected session. Other independent
   sessions remain authorized until a password change or other account gate.
3. Fresh reset sessions and subsequent staff/candidate logins use the current
   epoch. Trial completion, invitation acceptance and Microsoft SSO issuance
   also carry the correct epoch; SSO provider acceptance was not exercised.
4. Unchanged accounts retain pre-rollout signed v2 sessions at initial epoch
   zero. Their first password change invalidates those old sessions. Explicit
   development demo-token fallback remains non-production only.
5. No timestamp cutoff is used. Two changes in the same second are distinct;
   restoring an earlier password hash cannot revive its old sessions.
6. Profile edits and an unchanged hash do not rotate the epoch. Attempts to
   restore the epoch through a plain column update are ignored by the trigger.
7. The common HTTP guard checks account epoch plus session-specific revocation
   in one indexed, uncached control-database query. Unavailable/missing schema
   fails closed. Public password recovery and verified SSO entrypoints can be
   reached with a stale browser cookie.

Already authorized/in-flight work is not cancelled. This is not a device/session
inventory UI, and independently issued interview/upload capabilities and
provider OAuth credentials are not changed.

## Stronger native evidence

`pnpm run test:session-replicas --development-fingerprint=YOUR_VERIFIED_DEVELOPMENT_FINGERPRINT`
is an opt-in, fingerprint-guarded integration check. It constructs the real
Express app in child processes without importing the production bootstrap.
No production process is restarted by this command.

The passing exercise used **four distinct OS processes with two replacements
(restarts), 68 cookie/bearer protected-request assertions, and two real password
reset endpoint completions**:

- Both processes first accepted the same valid session.
- Logout through process A caused process B to reject copied cookie and bearer
  credentials. A separate same-account session stayed valid.
- After replacing process B, revoked credentials remained denied and a known
  non-revoked credential stayed valid. This rules out signing-key rotation or
  loss as a false explanation.
- The real reset endpoint invalidated older sessions in both processes; its
  fresh cookie and a new login succeeded. The old password and consumed reset
  token were rejected, including replay with a stale browser cookie.
- Direct password-hash changes also rotated the epoch. Tokens with identical
  issuance seconds but different epochs were distinguished correctly.
- Epoch rollback, profile edits and returning to an earlier hash were checked.
  Another account stayed usable.
- A second replacement retained the current credential while rejecting earlier
  reset/change/logout credentials.
- Candidate-specific login, reset and re-login also worked with the current
  epoch while the earlier candidate session was rejected.

Security notification transport was replaced **before app import**; exactly
two simulated notifications were observed. Parent/child HTTP guards prohibited
provider requests and unapproved local proxies. Child exits were checked for
network-guard failures. Only IPC-ready, owned child ports were approved and
approval was removed on exit. No real candidate email was sent by the tests.

Business fixture cleanup uses the existing write-ahead ownership journal. Reset
tokens for only the exact owned identities are removed inside its validated
cleanup transaction; no prefix scan is used. Passwords/reset links/session
tokens remain in memory and are not included in the recovery journal.
Expired session-revocation fingerprints follow the normal expiry policy.

## Re-run commands

```sh
pnpm run test:session-replicas --development-fingerprint=YOUR_VERIFIED_DEVELOPMENT_FINGERPRINT
pnpm --filter @workspace/api-server exec node --import ../../scripts/test-egress-guard.mjs --import tsx --test src/lib/auth-token.test.ts src/middlewares/sessionRevocation.test.ts src/lib/credential-session-version.test.ts
node --test scripts/test-egress-guard.test.mjs
```

The pure tests are registered in the assisted baseline. The real SQL/process
check remains opt-in because it requires an independently verified development
target. For an interrupted owned fixture, use the same command with
`--cleanup=JOURNALED_RUN_ID` and the verified fingerprint; it refuses cleanup
while another recorded owner is live.

The focused final pass also passed **17 authentication/epoch/guard tests** and
**36 network-guard and regression-runner tests**. Formatting passed; scoped lint
had zero errors and four existing warnings. No complete monolithic release
regression is claimed by these targeted checks.

## Deployment requirements for the external production team

- Review/apply `0113_session_revocations.sql`, then
  **`0114_credential_session_versions.sql`** to the identity/control database
  before enabling this build. Both were applied only in development here.
- The new migration adds one users column and a targeted password-change
  trigger. It does not replace existing RLS policies or require a broad schema
  push. Use the existing privileged control connection's reviewed permissions.
- Quiesce session issuance/password changes during API cutover and upgrade all
  replicas together. Old binaries neither enforce account epochs nor issue the
  new epoch after a changed password. Do not run a mixed-version security
  rollout and assume the new guarantee holds.
- Keep the trigger and epoch column in place; do not reset epoch values to zero
  or restore old credential state as a rollback shortcut. Coordinate a code
  rollback explicitly: an old binary does not enforce the new guarantee.
- No startup DDL, production database access, external deployment, live SSO
  round-trip or production capacity claim is included in this verification.

The pack contains both reviewed migrations and updated manual acceptance cases.
Manual results remain Not Run; local automated evidence does not replace the
team's deployment and provider acceptance.
