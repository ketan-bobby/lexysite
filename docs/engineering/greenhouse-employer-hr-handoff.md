# Greenhouse employer HR handoff

## Implemented locally

The existing manual ATS packet now includes a Greenhouse-specific HR guide.
After the authorized human approves and exports the current packet, a minimal
copyable reference identifies the external job, candidate and application,
packet fingerprint, recorded hiring intent and test-only warning.

The reference deliberately excludes candidate names, contact details, account
references, assessment narratives, financial terms, recordings and private
development data. HR reviews the separately exported packet under the existing
human-controlled process.

The reference is hidden for stale/unavailable packets, missing approval/export
evidence, changed mappings, invalid IDs, unsaved local changes and refreshing
access. Clipboard failure leaves selectable text rather than claiming a copy
succeeded. It neither records a manual-handoff receipt nor changes any workflow
or provider state.

## Why there is no generic create-offer call

Greenhouse Harvest v3 documents that `POST /v3/offers` can update an existing
offer chain, not merely create an independent new draft. Required custom fields,
start date and opening selection depend on the employer configuration. Existing
approval flows attach automatically. These are financial and business controls,
not defaults Lexy should guess.

HR must inspect the existing offer chain, supply employer-approved terms,
complete Greenhouse approvals and separately decide to send. A copied reference,
local packet approval or human-reported receipt does not establish remote offer
creation, approval, delivery, acceptance or employment.

## Verification

- Six helper tests cover minimal disclosure, approval/export requirements,
  authority/staleness, exact mappings, unsafe IDs and non-hire decisions.
- The existing isolated session/handoff browser runner now exercises the real
  HR-guide component with synthetic state, blocked clipboard fallback, local
  copy and hiding/reset after authority or staleness changes.
- No backend route, schema, migration, secret, permission or provider write was
  added. The helper test is registered in the assisted baseline.
- This increment is **manual HR assistance**, not completion of connected
  Greenhouse offer integration or live employer acceptance.

## Remaining connected implementation

The later [local offer-control protocol](greenhouse-offer-controls.md) implements
field validation, exact intent/version binding, separate human approval and
submission, SQL attempt claims and read-only recovery with simulated responses.
The later [HR workspace](greenhouse-offer-workspace.md) adds authenticated local
financial proposals, version history and human review/submission screens using
server-owned workflow authority and injected simulations. Verified employer
contract/connection custody, live transport and authorized live/deployment
acceptance remain. The [local committed ledger durability checks](greenhouse-offer-durability.md)
now pass with independent processes and a disposable PostgreSQL crash/restart.
Do not substitute a note receipt or local simulation for these.

## Official references reviewed

- [Create offer](https://harvestdocs.greenhouse.io/reference/post_v3-offers.md)
- [Create note](https://harvestdocs.greenhouse.io/reference/post_v3-notes.md)
- [Write endpoint migration guide](https://harvestdocs.greenhouse.io/docs/write-endpoint-migration-guide)

The review used public documentation only; no Greenhouse account was contacted.
