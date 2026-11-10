# Bounded native sourcing

## Corrected internal-testing policy

The original pricing prerequisite below was removed after the user reiterated
that billing must not limit internal Linx testing. Native internal discovery now
uses a permanent scoped request claim with unknown cost, not a fabricated quote
or a dollar-denominated cost operation. The result and uncertain-effect status
are visible on its hold. A retry or relabelled request cannot create another
provider call. Unknown costs do not block unrelated subsequent searches.

Workflow-linked draft regeneration no longer checks the pricing lock. Controlled
pilot action, scope and grant checks now report their actual authorization
requirements rather than treating a pricing lock as an authorization predicate.
Planning-rate-over-allocation warnings are informational, not dispatch blockers.
Human-defined search scope, current authority, consent and original ambiguous
contact claims remain protected. There is no claim of guaranteed dollar caps.

Five focused checks passed for HTTP execution without prices, role/tenant gates,
quoted-mode metering, unpriced concurrent claims, relabel/replay denial and
uncertain-effect/cancellation protection. Test transports are fictional and
outbound-network denial remains enabled; no paid provider acceptance is claimed.

The wider regression run found one obsolete assertion expecting high planning
rates to block reservation. It was changed to assert successful reservation and
passed its targeted rerun. All other regression cases passed. Frontend typecheck,
API build/security guards, lint and format gates passed; changed sourcing modules
have no API typecheck errors. The complete gate was not rerun after that assertion
correction. Both services restarted and the public sign-in screen rendered.

The remaining text records the superseded first implementation, not the current
internal-testing activation policy.

## Implemented scope

The sourcing budget screen now exposes readiness for a separate SerpAPI-only,
single-request discovery port. Its action is wired to approved reservations and
their current revision, job/journey snapshot, actor authority and lease fencing.
Other selected providers are explicitly unsupported by this port, not silently
omitted. Assisted Source Candidates remains unchanged.

The search is derived from the approved job title and location snapshot,
respects remote/no-location behavior, and requests at most ten results or the
smaller approved candidate limit. There is no provider fan-out, enrichment,
SDK retry, redirect following, AI scoring, import, outreach or stage advance.
Public profile references are bounded, deduplicated and restricted to HTTPS
LinkedIn personal-profile URLs; credentials, arbitrary hosts and tracking
parameters are discarded. Response bodies have a one-megabyte ceiling.

Results are journaled under the scoped job/reservation/operation and shown in
the corresponding hold. They are discovery references, not assessed candidates.
Usage attribution carries a distinct sourcing-reservation identity under the
existing workflow-area grammar, rather than impersonating an interview action.

## Pricing and uncertainty

The native port requires a verified, current server catalog bound. Neither an
HTTP payload, UI planning rate, public tariff, coupon nor environment toggle
can provide that authority. The catalog is still empty; no paid activation or
provider call was performed.

Every dispatch persists its cost claim before transport. Existing budget,
approval, cancellation, expiry and fencing checks are reused. A successful
SerpAPI response does not contain attributable USD charges, so the operation
retains the entire quoted bound as uncertain rather than inventing a settled
cost. Another operation or relabelled retry remains held until the original
cost is reconciled. Interrupted calls cannot be automatically resent.

## Verification

Tests use outbound-network denial and fictional results/prices:

- Bounded payload schema rejects extra flags, credentials and oversized counts.
- URL filtering, deduplication, truncation and malformed/provider-error handling.
- HTTP budget authority and foreign-job gates.
- Missing verified pricing creates neither a lease nor a cost claim.
- A native claim retains unknown actual cost and blocks relabelled/changed retries.
- Existing metering and assisted regression coverage is run alongside this change.

Final results: 535 assisted-regression tests passed, plus both standalone native
adapter checks. Frontend typecheck, API build/security guards, lint and
formatting gates passed. Both managed app services restarted successfully.
The public sign-in screen renders; this is not protected-page browser acceptance.

No live provider success, verified account price or authenticated browser
acceptance is claimed. Stabilized LLM settings, secrets, existing work orders,
commercial tiers and free Enterprise grants were not changed.

## Remaining work

Verified per-request account bounds and a controlled live acceptance remain
necessary for paid activation. Bounded PDL/enrichment/model ports and full
pipeline integration are not implemented by this single-search milestone.
