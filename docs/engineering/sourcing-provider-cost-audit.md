# Sourcing provider cost audit

Research date: 2026-10-05. Scope: candidate sourcing and related scoring,
geography and profile intelligence. No Stripe, checkout, customer payments or
automatic funding. No live vendor request was used for this audit.

## What is known, and what is not

Official public charging rules establish **units**, not the USD price on a
particular private account. Purchased bundles, negotiated tariffs, annual
commitments, bonus credits, unused/expired credits and taxes affect economics.
Subscription fee ÷ included credits is an **allocated consumption rate**, not a
new per-request invoice charge. PAYG credit purchases may also be prepaid.
Unspent allocation is not a provider refund.

The work-order controls now accept optional account-entered per-credit rates,
their accounting basis, non-secret plan/period source note and expiry. Rates
persist with the policy and invalidate its previous approval when changed.
Expired/missing rates are unknown, never free. Clearing a rate removes it.
These are planning inputs, not automatically verified vendor contracts.

### Monthly package presentation

The product owner chose monthly company plans using the existing price points.
Work-order Overview now leads with Starter, Growth and Enterprise references,
resolved through the existing country catalog for the billing-root company.
These do not change a contract, plan, fee, entitlement or payment. Annual
contracts see a monthly reference, not an annual invoice amount; missing country
is explicitly a US catalog reference. Existing seat/per-hire fees and tax terms remain.

Provider cost rows and account-rate inputs are platform-admin-only in the UI.
Existing plan capacities are not external profile quantities or vendor spend.
A shared monthly external-sourcing allowance is explicitly **not configured or
enforced** yet; the existing allocation holds remain per-work-order planning.
There is no invented monthly remaining balance or guaranteed candidate volume.

The cost view shows all six provider/call families and official references.
Its known provider allowance is partial and deliberately excludes unknown AI
usage. It never becomes a full-run quote. Preparing a hold is refused when even
the known selected-provider allowance exceeds its per-hold cap. Missing rates
do not prevent *planning* a hold; paid execution remains hard-locked regardless.

## Provider inventory

| Provider | Unit and current adapter behavior | USD evidence needed |
| --- | --- | --- |
| GitHub public REST | One user search + up to 8 profile GETs, engineering only. No per-request vendor fee for these public reads; rate limits apply. | No GitHub per-call tariff; hosting and AI costs remain separate. |
| People Data Labs | Person Search bills 1 credit per returned row. City→region→country→global relaxation can make 4 requests. Earlier short responses are discarded from the final list but still consume credits. Remote uses fewer tiers. Deduplication does not refund paid retrievals. | Actual person-search package price, included credits, commitment/overage terms and quota availability. |
| SerpAPI | Strict Google query + broad fallback can use 2 searches. Successful zero-result queries can charge. Provider failure/cache can be free; a network timeout is ambiguous. Keyless interactive preview uses a **paid AI simulation**, not a free search; real-run simulation is disabled. | Actual plan and effective allocated rate/overage. Cached billing classification must come from authoritative response/account evidence, not an empty candidate list. |
| Enrich Layer | Registry enriches LinkedIn URLs collected from final PDL/SERP responses; it does not use native person search. V2 profile default `use_cache=if-recent`: 1 base + 1 freshness = **2 credits**. Six successful-profile cap does not cap attempts: the loop may walk every seed. Malformed successful responses and timeouts need credit reconciliation. | Purchased per-credit rate, exact endpoint parameters/defaults, credit breakdown and quota. Existing code sends `url`, while the current documentation shows `profile_url`; compatibility is not accepted without validation. |
| AI scoring/geography | `generateJSON` uses GPT-4o through `chatCompletionWithAI`, max 4,096 output tokens per call. A geography batch can add a call. Model SDK retries can add HTTP attempts; usage metadata is currently discarded by the string helper. ICP generation and later matching/intelligence are additional work. | Exact model/version, input/cached/output token usage per attempt, billing route and retry policy. Public references alone cannot price a complete run. |
| Embeddings | `text-embedding-3-small` prefers direct OpenAI; proxy fallback/support is a separate concern. Candidate intelligence may generate embeddings and further matching calls. | Actual input tokens, model rates, each SDK attempt and authoritative successful usage. |

### Public examples, not chosen account rates

- SerpAPI standard monthly plans: $25/1,000 searches = $0.025/search;
  $75/5,000 = $0.015; $150/15,000 = $0.010; $275/30,000 ≈ $0.009167.
  Do not assume one of these is the current account's plan or that every quota
  credit will be used.
- Enrich Layer PAYG examples: $10/100 credits = $0.10/credit;
  $50/834 ≈ $0.06; $100/3,788 ≈ $0.0264. Default freshness means approximately
  twice that per successfully enriched profile. Annual tiers differ.
- OpenAI **standard** GPT-4o: $2.50 input / $1.25 cached input / $10 output per
  million tokens. GPT-4o-mini: $0.15 / $0.075 / $0.60, but this sourcing scorer
  does not currently use mini. Batch/flex/priority prices are not interchangeable.
- Replit's official AI Integrations documentation says public provider API
  prices, billed through Replit credits; direct OpenAI is billed by OpenAI.
  This does not make Lexy usage credits equivalent to USD vendor cost.

### Planning formulas

For requested batch size N (1–25), the illustrative current-adapter allowance:

- PDL: at most 4 × N credits.
- SerpAPI: at most 2 search credits.
- Enrich Layer: 2 × N × number of selected PDL/SERP upstreams.
- GitHub public reads: zero vendor fee; not zero total operating cost.

These are **planning assumptions**, not live guarantees. The existing assisted
and real-run context batch sizes are not bound to the new policy target; API
changes, fan-out, retries and additional profile paths must be audited before
these inputs can become executable bounds. The cost view says this explicitly.
There is no AI/run total because actual token sizes and complete call counts
have not been bounded. The existing metering ledger remains distinct from this
planning report: entered rates never settle operations or fabricate receipts.

## Remaining dispatch work

1. Establish account-specific evidence, quotas, expiry and billing basis.
2. Explicitly bound each actual request, each location tier, each seed attempt,
   each model retry and each downstream model/embedding call. Propagate
   cancellation instead of merely racing a provider-level timeout.
3. Capture original usage/credit/billing metadata and durable results. Never infer
   zero spend from a failed parse or missing candidate output.
4. Resolve uncertain charges through vendor evidence without repeating a paid
   attempt. Test recovery and result persistence before separately approving
   real execution.

Other platform services (email/SES, video/HeyGen, interview STT/TTS and Azure,
storage/hosting, and job-market APIs such as Adzuna) are **not part of this
sourcing allowance**. They need separate activity budgets if the product scope
expands. This report is not all-platform invoice reconciliation.

## Official sources

- [PDL Person Search billing](https://docs.peopledatalabs.com/docs/reference-person-search-api)
- [SerpAPI pricing](https://serpapi.com/pricing)
- [SerpAPI credit classification](https://serpapi.com/blog/calculating-search-credit-usage-with-serpapi)
- [Enrich Layer v2 profile defaults and add-ons](https://enrichlayer.com/docs/api/v2/people-api/person-profile)
- [Enrich Layer credit breakdown](https://enrichlayer.com/docs/knowledge-base/billing/credits-per-request)
- [Enrich Layer pricing](https://enrichlayer.com/pricing)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [GitHub REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Replit AI Integrations billing](https://docs.replit.com/features/integrations/replit-ai-integrations)
