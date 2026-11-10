# Document and hiring-manager share request contracts

## Scope

Corrected Express request parameter types on two document upload handlers and
three public hiring-manager share handlers. Named parameters stay scalar strings;
wildcard captures are not flattened, cast, trimmed or restricted to UUIDs.

Document uploads now explicitly return `Promise<void>` after sending the same
responses. Share handler changes erase completely from emitted JavaScript.

No prompts, AI configuration, storage configuration, permissions, pricing,
external sourcing availability or historical Linx records changed.

## Verification

- Four new real HTTP/auth/database checks passed for tenant and work-order
  document uploads, listing and deletion, linkage and response contracts,
  foreign/missing targets, candidate/unauthenticated callers and missing files.
  AI and object storage were doubled; no actual provider requests or objects
  were created. Disposable fixture tenants, users, jobs and documents were
  cleaned up.
- Five existing hiring-manager share privacy checks passed, including a
  successful share/view control, erased/DNC/foreign candidate rejection and
  revocation after erasure. Email delivery was simulated.
- Five existing middleware parameter/security checks passed, retaining named,
  wildcard and regex captures, origin rejection and admission ordering.
- Compiler diagnostics: **160 → 153**, seven removed, zero added.
  Remaining: **52 application/script diagnostics and 101 test diagnostics**.
  The full compiler still exits nonzero.
- New document checks and existing share privacy checks are registered in the
  assisted baseline.
- Nine batch/shard planning checks passed. Scoped lint and formatting passed;
  source comparison confirmed unchanged share JavaScript, document distillation
  and shared AI configuration.
- Managed API rebuild/security checks and restart passed. Login preview rendered
  normally. The pre-existing dormant-Stripe configuration alert remains; billing
  was not activated.

These checks do not establish live object-storage delivery, a browser upload
acceptance journey, recruiter-specific requisition ownership on document routes,
or production readiness. Existing document authorization remains tenant-subtree
based; no new ownership behavior is claimed.

Evidence: `/tmp/document-share-regressions.log`,
`/tmp/api-document-share-final.log`.
