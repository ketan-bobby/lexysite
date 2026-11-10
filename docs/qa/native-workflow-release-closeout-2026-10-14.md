# Native workflow engineering closeout — 2026-10-14

## Scope

This closes the engineering and regression work for Lexy's native recruiting
workflow. It does not certify a production deployment, language calibration,
real-person identity, inbox delivery, AWS deletion, or a connected external ATS.
It introduces no feature restriction or new commercial gate.

The regression began from clean application source at
`c5183aafc6f080209041c4aeeb05e12b5f4cf8c1`. This closeout document was added while
that run was in progress; application source was not changed during the run.

## Existing in-system capabilities

- Requisition configuration, approved journeys, shadow proposals, workflow
  state, pause/cancel controls, idempotency, and interruption recovery.
- Native sourcing, discovery/enrichment, screening, usage receipts and internal
  review controls. Unknown provider cost remains unknown, not zero.
- Advisory verification and an explicit human identity-review path. Synthetic
  clearance and AI advice do not establish real-person identity.
- Interest capture, controlled reply review and interview invitations.
- Consent-aware interviews, saved-answer capture/recovery, evaluation and
  explicit human review/decision controls.
- Employer-owned, version-bound controlled offers: HR/staff review inbox,
  notifications, human approval, deliberate sending, response handling and
  uncertain-attempt reconciliation.
- Native hiring alongside manual ATS mapping and human-reviewed packet export.
  Export is not remote synchronization or proof that external records exist.

The native six-stage pilot and its synthetic/test-only limits are documented in
`native-six-stage-evidence-audit-2026-10-10.md`. Customer-isolation coverage is
documented in `workflow-customer-isolation-2026-10-12.md`; offer browser coverage
is documented in `controlled-offer-browser-regression.md`.

## Fresh consolidated regression

The new canonical `pnpm test:assisted-baseline` run completed successfully:
**28 of 28 reporting checks passed, zero failed**.

Started: `2026-10-14T04:26:41.059Z`. Completed:
`2026-10-14T04:37:34.215Z`.

| Verification | Result |
| --- | --- |
| API tests | 677 passed, zero failed/skipped; 58 files across 18 bounded batches |
| Native workflow journey groups | 27 + 20 + 18 passed; these 65 are included in the API total, not additional tests |
| Frontend logic | 128 passed, zero failed/skipped |
| Controlled-offer browser checks | 36 of 36 passed, zero failed/not run |
| Planner/progress/lock/schema-fixture unit group | 33 passed, zero failed/skipped |
| Outbound-egress guard tests | Five passed, zero failed/skipped |
| Strict frontend and API typechecks | Both passed |
| API build and existing security/ownership/privacy/rubric guards | Passed |
| Repository ESLint | Zero errors; this is not a zero-warning claim |
| Repository Prettier comparison | Zero differing files |
| Running app preview | Normal anonymous sign-in page rendered; protected-resource 401/403 responses are expected before sign-in |

The complete machine report was inspected at
`/tmp/lexy-assisted-baseline-G1EFKE/summary.json`, with `complete: true`,
`status: passed`, `passedChecks: 28` and `failedChecks: 0`. That temporary path
is not durable storage; this committed narrative preserves the verified result
without copying raw test logs or fixture payloads into the repository.

The previous failed run remains historical evidence. Its sourcing-fixture
correction and supplemental passing tests were not retroactively represented as
a new all-green run. This new successful CLI run is separate from the older
managed validation workflows' historical failed statuses; those statuses were
not falsified or rerun merely to change their display.

## Separate retained database evidence

- 121 workspace schema metadata checks passed using a read-only transaction.
- 25 real PostgreSQL negative scenarios were detected in a verified development
  database, with intact-fixture checks before and after and confirmed rollback.
- A deliberately wrong database-instance fingerprint was rejected before
  fixture creation.

See `../ops/recent-database-readiness.md`. These are separate checks, not a claim
that the full regression reran every SQL-level negative scenario.

## External acceptance and connection work

| Item | Actual boundary |
| --- | --- |
| Linx acceptance | Team review of genuine authorized workflows and the prepared blinded language pack; this cannot be supplied by synthetic fixtures. |
| AWS acceptance | Live SES callbacks, private résumé upload/download and cleanup; team setup has been reported complete, but end-to-end verification is still pending. |
| Production verification | Confirm the actual deployed API/database target, run the read-only schema check there, and perform deployment smoke checks. Workspace results are not production attestation. |
| Connected Greenhouse | Manual mapping/export exists. Authorized remote record verification, synchronized writes and live provider receipts are not implemented by that export. |
| Billing reconciliation | Deferred until invoices/usage statements are available. This is not a blocker or payment restriction on the complimentary internal pilot. |

## Greenhouse connection prerequisite

The integration catalog distinguishes candidate ingestion from Greenhouse
Harvest access. Candidate ingestion alone does not supply the planned ATS
overlay.

Current official Harvest documentation, checked on 2026-10-14, describes v3
Bearer authentication. Partner integrations use OAuth authorization-code flow;
custom client-credentials integrations are for one customer's own account.
Do not implement a shared cross-customer Basic-auth token or confuse candidate
ingestion with tenant-bound Harvest access.

Source: <https://harvestdocs.greenhouse.io/docs/authentication>

An employer-authorized account/connection is still required to establish
scopes, ownership and real remote-record behavior. Native offer authority
remains separate: AI must not issue an offer automatically, and an external
employer-owned offer path must not silently activate native sending.

## Preserved boundaries

No stabilized model, prompt, provider routing, rubric, subscription entitlement
or pilot price was changed. No real candidate contact, offer, paid provider call,
production migration or historical Linx work-order edit was authorized by this
engineering regression.
