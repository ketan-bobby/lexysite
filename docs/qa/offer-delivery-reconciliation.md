# Native offer delivery reconciliation

## Boundaries

Offers remain employer-operated. Only the designated owner or sender can reconcile
an uncertain native offer, behind the existing job, candidate and privacy gates.
Approval alone never sends an offer.

- A check reads existing server-written email acceptance records; it does not call
  a provider or send another email.
- A receipt must match the employer, candidate, canonical recipient, workflow,
  offer version and original attempt. Conflicting receipts stay held.
- Provider acceptance is not confirmed inbox delivery or candidate receipt.
- Missing receipts, errors, bounces and unopened messages never establish no effect.
- A settled request may be released only after explicit human verification that
  the provider request terminated without acceptance, a written reason, an evidence
  reference and a separate confirmation. That returns the same offer version to
  Draft, archives its uncertain state and clears approval. A retry requires fresh
  review, approval and a separate human Send action.
- An unsettled request and an unattributable legacy attempt cannot be released.
- Unknown results preserve the private response capability. It remains unusable
  until acceptance is reconciled and is never exposed in staff API payloads.
- A send finalizer is attempt-bound; an old attempt cannot finalize a later retry.
- No pipeline stage, hiring decision, employment confirmation, fee or ATS sync is
  created by reconciliation.

## Verification

The recruiting-workflows HTTP/database suite passed all 47 tests. The affected
controlled-offer group also passed again after tightening reconciliation authority.
Coverage includes exact-attempt evidence, foreign/incorrect/simulated/error records,
concurrent idempotency, stale revisions, DNC, preserved terms and response link,
fresh approval before a later explicit retry, unsettled requests and legacy holds.
All email transport in these tests is intercepted; no real provider request occurs.

Frontend typecheck and workspace-library build passed. Lint has no blocking errors.
Changed sources pass formatting checks. The API startup build includes the existing
security guards. This is scoped verification, not a claim of a clean whole-backend
TypeScript check or certification of every live provider.

Browser verification uses a separate fictional employer/work order and a seeded
uncertain state. The fixture never sends an email or creates a provider receipt.
Any provider-no-effect acknowledgement in that fixture tests the human control,
not a real provider's delivery evidence.

The signed-in owner browser flow passed: inconclusive evidence stayed uncertain;
polling disabled a stale settlement form; blank/short inputs and missing
acknowledgement blocked review; Cancel preserved the approval; separate Confirm
returned version 1 to Draft with approval cleared and no send action. The summary
persisted after reload. At 390px the panel, confirmation and final summary fit
without horizontal overflow after closing navigation.

Initial harness attempts supplied only a development storage credential. The
identity request succeeded but the generated inbox client required its session
cookie. Correcting the private fixture cookie, without changing application auth,
allowed both reads and the real UI flow. A missing-Origin HTTP-client write was
correctly rejected; a browser-native same-origin check verified stale-form handling.
The optional unassigned-administrator browser check was not performed; backend
permission denials remain covered by the API suite.

## Remaining work

Direct provider delivery-status querying/webhooks and historical capability recovery
are not implemented here. Missing or unattributable evidence stays unresolved.
HR action notifications and the remaining live-provider/identity acceptance checks
remain separate work.
