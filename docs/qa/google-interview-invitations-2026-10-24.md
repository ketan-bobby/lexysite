# Google interview invitation checks — 2026-10-24

## Evidence

- API and frontend strict typechecks passed; generated clients/types were
  regenerated from the contract.
- Existing Google backend suite: **46 passed**, including optional consent
  persistence without upgrading existing readonly grants.
- New invitation/event/permission/HTTP suite: **20 passed**, covering exact approval, expiry,
  rotated proofs, simultaneous sends, cross-provider claims, immutable details,
  pending/failed Meet, hostile receipts/URLs, privacy and consent fences, lost
  responses, read-only recovery, and denial before service construction.
- Outlook provider/revision/operation backend suites: **49 passed**.
- Google invitation browser: **15 passed**; Google staff browser: **13 passed**.
  Both use the real components/generated clients with isolated mocked APIs.
- Existing Outlook panel browser **14 passed** and Google pilot browser
  **6 passed** after the shared harness was extended.
- Schema audit/generator suite: **14 passed**. The actual metadata audit passed
  **207 checks**, including the new defaults, column types and private storage.
- The existing development-targeted staff repository rollback fixture passed.
- A second explicitly development-targeted private rollback fixture copied
  the real table definitions/constraints and proved duplicate provider claims
  fail, consent cannot exist without a grant/flow, provider receipts cannot be
  relabelled, and the request role cannot read either table. Independent cleanup
  found zero remaining fixture schemas.
- Migration `0088` was applied only through the explicit development handle.
- API build/security guards completed and the API restarted. Repository lint
  returned zero errors; warnings remain in the repository.
- Formatting passed for all **54 changed text files**. The combined command
  exhausted its time budget during the separate full-repository format scan;
  that full scan is not claimed complete.

## Limits

Tests use synthetic identities, claims, local signing keys and mocked provider
responses; they do not prove real staff login/OAuth, live Google policy, email
delivery, RSVP or live Meet creation. The staff-only screenshot route renders
login when unsigned; isolated browser suites cover the changed controls.

No real Google guest event, invitation email, candidate contact, native stage
transition, production migration/deployment, AI configuration or billing limit
was changed. The expanded assisted baseline registers the new checks; the
whole baseline was not rerun and is not claimed green.

See [implementation and live acceptance](../engineering/google-interview-invitations.md).

```sh
pnpm --filter @workspace/api-server run test:google-invitations
pnpm --filter @workspace/api-server run test:google-calendar
pnpm --filter @workspace/lexy run test:google-invitation-browser
pnpm --filter @workspace/lexy run test:google-staff-calendar-browser
```
