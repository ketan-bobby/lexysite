# Candidate-account closure — 11 October 2026

## Boundary

Candidate erasure now closes an eligible candidate-only login in the same
transaction as the database cascade. The account row remains as a minimal
tombstone for historical references; its contact details, name, password,
avatar pointer and preferences are scrubbed. A permanent closure marker is
separate from reversible administrative suspension.

Identity resolution uses the candidate's stored user ID, never an email match.
Staff and admin identities are preserved. Another live candidate profile using
the identity defers closure; erasing the last linked profile permits closure.
Multi-region operation requires review because one regional database cannot
prove that no other live profile exists elsewhere.

The erased profile is unlinked from its identity. Candidate-only avatar
references are captured in the durable file receipt before pointers disappear;
shared staff or other-live-profile avatars are not collected by this step.
Account closure does not certify deletion of every historical actor reference,
external identity provider, cached copy or independent employer record.

## Access and recovery

An API-wide check rejects old signed bearer and session-cookie credentials,
including endpoints that bypass tenant context. Cookie-only rejection clears
the stale session cookie. A stale bearer header does not clear an unrelated
staff cookie. Fresh credential login and explicit logout remain available.

Portal identity resolution excludes suspended/closed users and erased profiles.
Password login, password recovery, Microsoft existing-user resolution (including
its insertion-race path) and user editing respect permanent closure. Reset and
invitation tokens belonging to a closed candidate-only user are removed.
Recovery-token minting locks the user and checks the marker; reset-password
updates are conditioned on the marker remaining null.

Changing `status` back to active does not restore a closed identity. A person
can later register/provision a new identity with their original email, but that
does not reconnect old tokens or revive the erased profile.

The erasure queue shows whether closure completed, staff identity was preserved,
or closure was deferred. Confirmation screens disclose the account effect and
retention exceptions before erasure.

## Verification

Five new account/authentication tests passed, alongside the 16 existing focused
erasure/recovery tests. Correct credentials worked before closure; even restoring
the old password hash and active status did not reopen the identity. Frontend
typecheck, API build/security guards, schema drift, lint (zero errors) and
formatting passed. The full API typecheck still has wider typing errors; scoped
account/cleanup modules and closure-field references were checked separately.

Disposable fixtures cover credential scrubbing, token revocation, old bearer
and cookie rejection, password/recovery denial, status-only reactivation denial,
shared staff preservation, remaining-profile deferral, rollback and protection
against email-only matches. The real password-login, forgot-password,
reset-password and authenticated-user controllers are exercised with blocked
external egress. Existing relationship-rich erasure/retry tests cover all three
erasure paths and ordinary application-role rollback/isolation.

The additive migration is
`scripts/sql/2026-10-11-candidate-account-closure.sql`; it was applied to the
configured workspace API database without modifying accounts or replacing RLS.
Apply it to the correct external deployment database before rollout. Publishing
must not be assumed to migrate that database.

No real Linx accounts were closed. No live AWS deletion proof was performed.
Historical erased accounts were not backfilled or automatically closed.
Provider-based SSO was not exercised live. AI models, prompts, provider routing,
pricing and sourcing were not changed.
