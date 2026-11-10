# Zoom stale-link alerts — verification

Scope: generic recipient-owned in-app alerts for the manual Zoom path.
No provider writes, candidate emails, model changes or new database migration.

The complete real HTTP/PostgreSQL scheduling run passed 113 of 114 cases.
The remaining assertion incorrectly assumed that the existing generic
user-notification history API rejects candidates. It actually allows any
canonical active user to read only their own rows. The assertion was corrected
to verify that a candidate, even with forged staff-role token claims, cannot
retrieve another recipient's Zoom notices. No production authorization was
changed to satisfy the test. The focused Zoom alert pass verifies that correction.

New coverage includes concurrent-scan dedupe, repeat/read receipt preservation,
public versus private changes, replacement/removal, current assignment,
additional recruiters, foreign-tenant roster exclusion, suspension/account
erasure, candidate DNC, cancellation/completion, invitation conflicts, real
inbox read isolation and private-storage readiness failure.

Five Zoom backend unit checks and API TypeScript passed. Scoped lint has no
errors; the existing API bootstrap has two unrelated unused-import warnings.
The browser was not retested: this change uses the existing generic notification
list, action link and polling bell, with no frontend edits. HTTP/database checks
exercise the real history endpoint and notification storage instead.

Development fixture writes were confined to owned private schemas after explicit
database fingerprint verification. This is not live Zoom/OAuth acceptance or
production RLS verification. Previous manual-link migration 0090 remains a
production rollout prerequisite; this notification change adds no further DDL.
