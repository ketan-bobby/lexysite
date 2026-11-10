# Native controlled offers — verification

## Delivered

- Employer-authored structured terms and a manual letter on a candidate's native work-order workflow after a reviewed human Hire intent.
- Draft, review, version-bound approval, explicit send, withdrawal, expiry and private-link accept/decline.
- Editing saved terms creates a new version and clears approval. Unsaved edits cannot approve/send the old version; version history remains readable.
- Authorised approvers only; assignment/tenant/privacy gates; optimistic revision checks and idempotent mutations.
- Durable send claim before transport, with a distinct finalization receipt per attempt. Duplicate requests do not send again. Simulations do not report Sent; unknown delivery requires human recovery rather than blind retry.
- Public responses are bound to the current unexpired token. Only token hashes persist in workflow state; staff responses strip hashes and log/audit paths redact bearer links.
- Interpreting an offer response does not mutate applications, employment outcomes or fees. Legacy offer-acceptance bookkeeping cannot bypass a managed offer.
- Lexy branding on the public page, explicit synthetic warnings, and a mandatory UI acknowledgement that the manually written letter matches the saved terms before approval. Text is not automatically rewritten or semantically validated.

## Checks

- Native workflow HTTP/regression suite: **37 passed, 0 failed**, using a fake email transport and isolated fictional records.
- API build and ownership/privacy/route guards passed.
- Frontend typecheck passed.
- Managed API and frontend workflows restarted and served requests.
- One signed-in browser pass verified draft v1, review, approval, salary edit, v2 with cleared approval/history, second approval and send-confirmation cancellation.
- An unsigned browser context verified public decline-confirmation cancellation and acceptance, persisted acceptance after reload, removal of response controls, and readable 390px layout.
- That browser pass found missing recipient branding and missing test-only text in the send dialog; both were fixed afterward. The manual-letter mismatch it identified prompted explicit approval-review safeguards and unchanged-letter warnings. These focused changes received type/code and screenshot checks, not a second full browser pass.
- Database inspection of the isolated browser fixtures confirmed an approved staff v2 and an accepted recipient offer, unchanged application stages, **zero employment outcomes and zero fee items**.

## Boundaries

No real email, provider request or new interview invitation was authorised or sent for this milestone. The pre-seeded recipient offer used an injected fake transport. No live offer-delivery proof is claimed.

No LLM, provider routing, prompt, rubric, subscription restriction or external-sourcing configuration was changed. Existing Linx work orders and completed pilots were not rewritten. Temporary browser fixtures are removed after verification.

This is not a legal e-signature/identity-verification product or an automatic legal-letter consistency checker. The full backend typecheck is not claimed as a clean gate; the combined full check exceeded its timeout, while the API build, targeted tests and frontend typecheck passed.

Remaining native finish-plan steps are audit-preserving final-decision corrections, assessment-quality validation and one planned fresh Linx end-to-end run. Cost reconciliation remains parallel and non-blocking. ATS integration follows these native steps.
