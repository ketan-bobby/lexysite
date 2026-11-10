# Native PDL and EnrichLayer sourcing

## Implemented

- Native provider ports are exposed through the existing sourcing registry.
  Each selected discovery port makes one request: PDL first, then SerpAPI.
- Selected EnrichLayer enriches deduplicated canonical LinkedIn references
  returned by discovery, bounded by the human-approved candidate scope.
- Enrichment seeds must be saved discoveries from the same tenant, job and
  reservation. Another run's URL is not execution authority.
- Each discovery and each profile enrichment has its own permanent scoped claim,
  outcome and operation key. Relabelling, retries and uncertain outcomes cannot
  resend the original effect.
- Every native HTTP port uses the existing best-effort usage transport. The
  hold/phase scope plus observed operation key associates receipts with the
  original operation; request URLs and credentials are not stored as usage keys.
- No invoice or verified-rate prerequisite was introduced. Costs remain unknown.
  Existing assisted sourcing, stabilized models and provider routing are unchanged.
- Missing/disabled providers are visible. A missing PDL account does not prevent
  another approved configured discovery port from running. Enrichment can use PDL
  seeds without a SerpAPI account.
- The UI displays per-provider availability, status, profile references and
  skipped-step explanations. Missing saved results are not represented as a
  confirmed empty provider result.

## Boundaries

Native outputs are profile references, not imported candidates, assessments or
candidate contacts. The native PDL port does not wrap the assisted tier-relaxation
orchestration or introduce hidden model calls. GitHub remains available through
the existing assisted path and is explicitly identified as outside this native
run when selected.

A repeated run with prior claims exposes the original records without sending
more provider requests. A partial/uncertain run is not automatically resumed
into additional spending. New controlled tests use a fresh approved reservation.

## Verification

64 provider, parser and sourcing-control cases passed with outbound vendor access
denied. A subsequent targeted pass covered the new foreign-run seed rejection,
candidate-scope ceiling, receipt/operation association and updated native flows.
Eight usage/coverage tests also passed, including preserved native/fetch wiring
and stabilized OpenAI constructors.

OpenAPI code generation, library typechecks, frontend typecheck and changed-file
lint passed. Changed modules have no API typecheck diagnostics; known full-API
issues elsewhere are not claimed resolved.

The runtime availability check reports all three native providers configured and
enabled. This checks configuration presence only, not live provider acceptance.
No real provider purchase, profile request or candidate email was part of these
test runs.
