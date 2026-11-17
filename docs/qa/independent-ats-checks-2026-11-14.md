# Independent ATS and scheduling checks — November 14, 2026

## Scope and result

Development-only changes, synthetic identities and mocked provider transport.
No production access, external ATS write, candidate invitation, OAuth permission
change or database migration was performed by this work.

- **86 tests passed** across the Zoho execution protocol/HTTP adapter, Greenhouse
  direct transport, gateway and record binding, and local manual-handoff receipt.
- **10 frontend logic tests passed**, covering the candidate dropdown boundary
  and Outlook sharing receipt/save behavior.
- API and frontend strict TypeScript checks passed.
- This is a focused verification run, not a new full assisted-baseline result,
  signed-in browser acceptance or live provider acceptance.

## Added coverage and behavior

Five new composed Zoho tests connect the real execution protocol to the real
HTTP adapter through a mocked transport: accepted response, lost response,
wrong-candidate receipt, permission denial and mismatched read-back.
They check the committed-journal double is claimed before transport, the
authority-fence double is held during mutation, exact candidate/job scoping,
deduplication after replacement writer construction, and read-only recovery.
They do not establish SQL durability, deployed authorization or employer
transition eligibility.

Five new manual-handoff tests independently require each prior approval/export
field and verify that a human-reported record contains no provider delivery,
offer delivery or employment claim. These controls already existed; no new
Greenhouse offer-send capability was added.

Outlook sharing now cancels a pending status query before saving its explicit
choice, preventing an earlier read from overwriting the confirmed save.
Five new logic tests cover cancellation ordering, on/off receipt validation,
lost/malformed/contradictory responses, and no automatic retry. The new test file
is registered in the assisted-baseline frontend manifest.

The earlier candidate-dropdown fix has five regression tests covering canonical
first/last names, legacy names, partial names and invalid rows.

## Repeatable focused commands

Run from the repository root:

```sh
pnpm --filter @workspace/api-server exec tsx \
  --import ../../scripts/test-egress-guard.mjs --test \
  src/lib/ats-connectors/zoho-stage-write.test.ts \
  src/lib/ats-connectors/greenhouse-direct.test.ts \
  src/lib/ats-connectors/greenhouse-gateway.test.ts \
  src/lib/ats-connectors/greenhouse.test.ts \
  src/lib/ats-handoff-receipt.test.ts

pnpm --filter @workspace/lexy exec tsx --test \
  src/lib/outlook-panel-consent.test.ts src/lib/schedule-applications.test.ts

pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/lexy run typecheck
```

The backend command blocks unapproved provider egress. It uses synthetic
transport/journal fixtures, not the live Zoho or Greenhouse account.

## Deployment and team checklist

1. Rebuild/deploy the frontend for canonical candidate names and the panel status
   read-cancellation fix.
2. Rebuild/deploy the API for the earlier minimal delegated mailbox identity
   lookup fix in `outlook-calendar-core.ts`. Its 25 focused tests passed in the
   earlier fix; they are not added to the 86 above.
3. These November 14 fixes introduce no migration. Existing deployment
   prerequisites, including authentication migrations, still apply.
4. Verify the dropdown and Outlook sharing while signed in to approved staff
   accounts. Confirm sharing persists after reload and revocation still works.
5. Continue the authorized dummy-applicant journeys in Zoho and Greenhouse.
   OAuth success is not proof of application association, stage permission,
   note publication, delivery or safe side effects.

## Still unfinished

- **Zoho live stage dispatch:** the application has no trustworthy verified
  employer/application-specific transition-proof origin. Live action wiring
  remains unavailable. Do not turn stage catalogue/history data into transition
  permission or expose a browser `verified: true` bypass.
- **Connected Greenhouse offer handoff:** local human approval/export/handoff
  is not a completed remote offer integration. The customer-specific capability
  and authorized employer acceptance remain separate product work.
- **Live acceptance:** Outlook/Google/Zoom/Recall lifecycle, signed callbacks,
  real recordings, external deployment and LINX independent review remain open.

The existing downloadable ZIP is a dated snapshot. Share this addendum alongside
it; its older source manifest does not attest to these later edits.
