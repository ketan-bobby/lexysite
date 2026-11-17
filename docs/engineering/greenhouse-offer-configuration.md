# Greenhouse employer-configuration reader

**Current integration:** the [controlled assembly](greenhouse-offer-assembly.md)
now binds this reader's metadata fingerprint to an independent employer review.
Missing rules still cannot be inferred. The default app remains unavailable until
real custody/review/evidence loaders and explicit bootstrap are supplied and
authorized employer acceptance passes.

## Status and entry point

Implemented and locally tested on 2026-11-15. Call
`greenhouseOfferHttp(...).readEmployerConfiguration(snapshot)` with the existing
explicitly injected server authorizer and fetcher.

**The application still does not import this transport.** This increment adds no
routes, public settings screens, schedulers, credential sources, migrations,
notifications or connected financial actions. Tests use synthetic JSON responses
behind the egress guard. No real Greenhouse or production calls were made.

## What it reads

The reader queries fixed Harvest v3 GET endpoints for:

- The exact job's status, template marker, office IDs and department.
- Active offer custom-field definitions, including required/private flags,
  data types, system roles, version-triggering behavior and defaults.
- Active select choices, retaining both numeric option IDs and names.
- Office/department field restrictions and complete returned ancestry graphs.
- Open openings on the exact job.
- Current unresolved Created offers on that job, selecting only identifiers,
  opening reservations, version, timestamps and resolution state—not compensation.
- Job-level approval metadata and, when an existing chain is supplied,
  approval metadata for that exact offer.

The existing permission/custody proof is mandatory for every request. In addition
to private-offer read and approval-read authority, the reader requires the exact
list scopes for custom fields, options, field offices/departments, offices,
departments, jobs and openings. Missing scopes cause rejection before network I/O.
The authorizer is called again after each response; lost authority hides the result.

The read does **not** require financial write permission or manufacture a human
hiring decision just to inspect settings.

## Interpretation

Field visibility uses office **and** department rules together, including ancestor
matches. A job with no selection for a dimension does not get an invented
restriction for that dimension. Missing parents, cycles and inconsistent
relationships fail the complete read instead of silently excluding required data.

Required/private/version flags are preserved. Unsupported field types remain in
the inventory as unsupported; they are not silently converted to text or omitted.
Default values are represented by their presence and fingerprint, not automatically
filled into financial terms. Zero/blank defaults are not mistaken for no default.
Choice labels are not assumed to be the wire-format identifier.

Opening IDs are the numeric Greenhouse primary keys, not the free-form external
opening labels. An opening referenced by an unresolved Created offer is marked
reserved, including reservations on the current application. An unreserved open
opening is only a **candidate**; no reservation or concurrent-write guarantee is
claimed. Retaining an existing offer's opening requires explicit review.

The result binds the employer, connection, caller, workflow, application/job/candidate
and source snapshot revision. It contains a configuration fingerprint and separate
approval states, not a financial authorization.

## Completeness, stability and bounds

- Two complete, canonically sorted sweeps must match. Relevant changes between
  sweeps reject the result; harmless response ordering does not.
- At most 100 offer definitions, batched into groups of at most 50 field IDs.
- Each batch reads at most 500 options, 500 office rules and 500 department rules;
  combined child collections are bounded to 1,000 rows each.
- At most 500 offices/departments/openings and 100 current Created offer reservations.
- At most one matching job or approval flow. Duplicate IDs/keys, ambiguous choices,
  foreign parents, archived rows and unsafe numeric IDs are rejected.
- No pagination is followed. A Link header or over-limit response rejects the
  complete read; a partial catalogue must never be treated as complete.
- At most 28 fixed GETs across both sweeps, under **one** maximum ten-second
  deadline including authorization and body consumption. Every response is capped
  at 512 KiB. There are no automatic retries or redirects.
- Deadline cancellation prevents later requests from continuing the read plan.
  No partial inventory is returned after failure.

Matching sweeps are **not an atomic provider snapshot**, a financial claim or a
replacement for fresh pre/post offer-chain checks at submission. This bounded
implementation will explicitly fail for larger paginated catalogues; it does not
silently truncate them.

## What remains unknown or requires independent verification

The result always has `executionReady: false`. It cannot promote an employer
contract, approve terms, request approvals or send an offer.

- A managed start-date/opening requirement is known only if an applicable
  explicitly identified system definition is returned. Otherwise it stays null,
  never a guessed false.
- Currency allowlists and minor-unit precision stay unknown. A salary default
  containing USD is not proof that USD is the only allowed currency or that every
  currency has two decimal places.
- Missing candidate approval flows are not proof of a waiver or a missing
  configured prototype. Actual employer approval configuration needs verification.
- The reader receives an already-authorized application binding; it does not
  independently prove that application/candidate association.
- Reading metadata does not establish that a future offer operation has no
  candidate-delivery side effects.
- Draft/closed/template/unknown-template jobs and missing select choices remain
  explicit unresolved conditions.

Real credential custody and advanced-permission verification remain separate
dependencies, as documented in [permission evidence](greenhouse-offer-evidence.md).
The next integration is to combine discovered metadata with separately verified
employer rules and the human-controlled durable provider workflow. BUILD-02 remains
Blocked until that assembly and authorized employer acceptance are complete.

## Verification

```sh
pnpm --filter @workspace/api-server run test:greenhouse-offer-http
```

**75 tests passed:** the prior 51 transport/permission/approval tests plus 24
configuration-reader cases. API type checking and changed-source formatting
passed. The configuration tests are also registered in the assisted baseline;
the full baseline, browser journeys and live employer acceptance were not run.

Cases include inherited AND-scoping, reserved openings, true/false/unknown managed
requirements, unsupported fields, zero defaults, all missing scopes, revoked
authority, malformed/foreign/archived rows, hierarchy cycles/orphans, pagination,
limits, drift, harmless reordering, caller mutation, cumulative deadlines and the
maximum 100-field/28-request plan.

## Official contracts consulted

Checked on 2026-11-15:

- https://harvestdocs.greenhouse.io/reference/get_v3-custom-fields
- https://harvestdocs.greenhouse.io/reference/get_v3-custom-field-options
- https://harvestdocs.greenhouse.io/reference/get_v3-custom-field-offices
- https://harvestdocs.greenhouse.io/reference/get_v3-custom-field-departments
- https://harvestdocs.greenhouse.io/reference/get_v3-offices
- https://harvestdocs.greenhouse.io/reference/get_v3-departments
- https://harvestdocs.greenhouse.io/reference/get_v3-jobs
- https://harvestdocs.greenhouse.io/reference/get_v3-openings
- https://harvestdocs.greenhouse.io/reference/get_v3-offers

The field dictionary describes `required` as a form-level rule while the create-offer
contract also describes required-field 422s. Preserve the stricter reviewed
requirement; do not probe financial writes to learn whether a blank is accepted.
