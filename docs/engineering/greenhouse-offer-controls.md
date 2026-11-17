# Greenhouse local financial-offer controls

## Status and scope

Implemented on 2026-11-14 as an **internal, dependency-injected protocol**.
This original increment supplied no public endpoint or screen. The later
[employer HR workspace](greenhouse-offer-workspace.md) adds authenticated local
proposal editing/review. The later
[controlled provider assembly](greenhouse-offer-assembly.md) adds an opt-in
draft/approval-request workflow with durable intermediate receipts. No increment
supplies default live credentials or a candidate-delivery operation.

This does not enable connected offers for customers. Manual HR handoff and local
financial proposal review are available; BUILD-02 remains Blocked.

## Implemented controls

- Strict employer-specific required fields, field types, permitted choices,
  currencies, amount bounds, start dates and permitted openings.
- Employer/account, connection revision, application/candidate/job and existing
  offer-chain binding. Short-lived contract evidence must match those bindings.
- A fingerprint covering human-authored terms, the current human decision,
  designated owner/approver/submitter, source revision and employer contract.
  Different designated humans can operate on the same intent; edits invalidate
  the prior fingerprint.
- Separate preparation, explicit human financial approval and explicit human
  submission. The protocol cannot send an offer to a candidate.
- A SQL audit journal with employer/workflow advisory locks, bounded history,
  unique request handling and a claim recorded before the simulated write.
  No migration was introduced; the journal uses the existing audit table.
- Exact preflight comparison of the remote offer chain and approval state.
  Already-matching terms are not attributed to a new submission.
- Accepted submissions require an exact chain/terms read-back and pending or
  approved remote approval state before becoming `verified_submission`.
  That label does **not** mean Greenhouse approved, delivered or accepted an offer.
- Uncertain results stay held. They cannot expire into an automatic resend.
  Recovery reads only; matching terms become `observed_match`, not proof that
  Lexy caused the remote change.
- Journal entries retain hashes and internal operator references, not financial
  values, external candidate identifiers, credentials or raw provider bodies.
  Each transition records the actual operator, not the original approver.

## Files and repeatable checks

- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-policy.ts`
- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-controls.ts`
- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-store.ts`
- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-controls.test.ts`

Run `pnpm --filter @workspace/api-server run test:greenhouse-offer-controls`.
The suite is also registered in the assisted baseline.

Verification on 2026-11-14: **24 tests passed**, API type checking passed, and
formatting and whitespace checks passed. The full assisted baseline was not rerun.

Tests exercise a **verified local database only**, with a private temporary audit
table, forced rollback and fully simulated provider responses. They cover valid
human submission, missing/forged approval, role/scope mismatch, edited terms,
lock-time authority changes, remote-chain/approval changes, stale proof, uncertain
acceptance, failed receipt persistence, reconstructed-service duplicate
protection, read-only recovery and audit payload minimization.

These fixtures do not prove committed recovery across process kills, independent
database connections, database restarts, live Greenhouse behavior or production
capacity. Reconstructing an object inside a rollback transaction is not a
multi-instance crash test. No candidate messages or Greenhouse requests occur.

## Remaining implementation before live use

1. **Concrete trusted source and evidence adapters.** Resolve active staff/HR
   authority, tenant/application visibility, current human decision, terms and
   exact offer/source version from authoritative server state. Advance the source
   revision even when an edit later restores old values. Hold/recheck authority,
   custody and source locks through each fenced operation.
2. **Employer-specific contract discovery and verified transport.** Discover the
   employer's fields, opening rules and actual approval behavior. Confirm that the
   exact proposed operation cannot deliver to candidates. The
   [bounded Harvest wire layer](greenhouse-offer-http.md) is now implemented
   and locally tested with no automatic retries. The controlled provider
   assembly now performs claim-bound draft/approval requests and exact read-back.
   Actual custody, independently verified employer rules and authoritative
   server input bindings still remain.
3. **Authenticated route and UI integration.** Implemented for local proposals
   and simulated controls in the linked workspace increment. Live operation still
   depends on the trusted employer contract and verified transport above. No
   client-authored proof is accepted; the gateway financial-write ban is unchanged.
4. **Independent durability and authorized employer acceptance.**
   [Committed ledger crash recovery](greenhouse-offer-durability.md) now passes
   in a private socket-only PostgreSQL cluster with separate processes and real
   commits. Actual deployment recovery and the real employer's dummy application,
   fields and approval chain still require authorized acceptance. Candidate
   delivery remains a separate human responsibility.

This work supplies local controls for that integration, not those missing
employer adapters or live acceptance. Do not treat a note receipt, exported packet
or simulated provider result as a connected financial-offer receipt.
