# Controlled native provider live check

**Update — 2026-10-10:** EnrichLayer subsequently passed a standalone live retest.
A fresh isolated combined PDL/SerpAPI → EnrichLayer run also succeeded, with
two enriched profiles, four operation-bound HTTP 200 receipts and a replay
adding zero requests. See
[the current six-stage evidence audit](native-six-stage-evidence-audit-2026-10-10.md).
The original failed attempts below are preserved as historical evidence.

## Live evidence

Two dedicated provider-only work orders were created under the existing isolated
pilot tenant. Original work orders, interviews and candidate records were not
modified. There were no candidate imports, assessments or contacts.

The initial location-specific query produced no usable seeds. Its original
claims are retained, including PDL uncertainty. A live database constraint rejected
the native discovery observation label, so those two requests have incomplete
receipt coverage. They were not repeated to reconstruct accounting.

A fresh remote Software Engineer query was separately scoped and approved:

| Provider | Live outcome | Saved evidence |
|---|---|---|
| PDL | HTTP 200; two public profile references | Scoped operation key; provider reported two credits |
| SerpAPI | HTTP 200; two public profile references | Scoped operation key; provider request identifier |
| EnrichLayer | Two profile requests returned HTTP 403 | Individual scoped operation keys and provider request identifiers |

Repeating the execution command for the same reservation returned a replay and
added zero provider attempts.

## Repairs and remaining blocker

The additive native observation-label migration was applied to development.
Upgrade tests and a fake-transport durable persistence check pass; forced RLS,
application-role denial, existing labels and unknown-cost semantics are retained.
The isolated live runner checks this prerequisite before beginning a live test.
Normal application execution still does not depend on receipt persistence.

EnrichLayer's documented zero-credit credit-balance endpoint returned HTTP 200,
confirming that the configured key authenticates, but reported no available
credits. Lexy has not imposed a payment or commercial-tier block. The provider
account must have usable credits before live profile enrichment can succeed.

Public EnrichLayer documentation also specifies `profile_url`, not the legacy
`url` query parameter. Both native and assisted transports now use the documented
parameter; a pure endpoint-contract test covers the native request. No models,
prompts or provider routing were changed.

At the time of this check, successful live enrichment after this correction
remained unverified. Failed
profile attempts are not reset or silently retried. A later test must use fresh
approved execution authority after the provider account is ready.

Actual monetary costs remain unknown. PDL's two reported credits are usage
evidence, not a dollar charge. Missing historical receipts are not fabricated.

References:
- https://enrichlayer.com/docs/api/v2/people-api/person-profile
- https://enrichlayer.com/docs/api/v2/meta-api/view-credit-balance
