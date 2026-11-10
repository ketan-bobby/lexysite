# Provider coverage and public-rate evidence

Internal platform operations only. No customer pricing, plan allowance,
spending authority, invoice reconciliation or production rollout is introduced.

## Observation coverage

| Path | Observation | Still unknown |
| --- | --- | --- |
| Every production OpenAI/Azure OpenAI constructor | Per HTTP attempt, SDK retry header and reported tokens | Account charges, receipt reconciliation, service-tier/alias tariffs |
| Direct embeddings | Model and reported input tokens; vectors/text not retained | Actual account price and repeat/dedup charges |
| Interview vision and career/intake/coaching clients | Same protected transport observation | Attribution/classification can remain unknown; private activity is never employer-visible |
| OpenAI/Azure speech | Existing instrumentation and response formats preserved | Missing provider duration/billed characters remain unknown |
| Deepgram | Model, submitted bytes, provider `metadata.duration` when present | Invoice duration/rounding, plan and rebates |
| ElevenLabs/Sarvam STT | Model and submitted audio bytes | No invented duration or credits |
| ElevenLabs TTS | Requested model and Unicode input-character observations | Billable character/credit rules and plan; input text not retained |
| iFlytek | Recognition-session start/completion/uncertainty and PCM bytes after conversion | No HTTP status, session seconds or vendor charges invented; locally skipped audio opens no metered session |
| HeyGen | Upload/generate/status/voices classified separately | No video/session ID retained, no generation-to-poll receipt reconciliation |
| SerpAPI/PDL/EnrichLayer | Each downstream HTTP invocation, including adapter fan-out | Successful matches/results are not credit debits or invoices |
| SES | Native request handler downstream of SDK retries; HTTP status, retry index, recipient submission count | Acceptance is not delivery or invoiced recipient count |
| Graph outbound email | HTTP outcome and recipient submission count; SES fallback independently observed | Microsoft subscription allocation; auth/reply-sync requests are outside this coverage |

Observations preserve original response objects, native SDK streams/results,
errors, fallback routing and message-send authorization. Bodies/credentials,
prompts, transcripts, vectors, images, mail and request/vendor IDs are not saved.
Status polls are not counted as newly generated video. WebSocket sessions are
not labelled as HTTP requests. All costs remain explicitly unknown.

The CLI reports missing usage/duration/retry metadata, transport invocations,
WebSocket sessions and recipient submissions separately. Invocation counts
include locally failing/blocked calls: they are not proof a vendor accepted
or billed a request. Older rows lacking new counters remain missing, not zero.

## Public-rate evidence — checked 2026-10-06

Official model pages were fetched, not just search snippets. Published standard
on-demand rates below are **USD per million tokens**, not actual account charges.

| Requested model | Input | Cached input | Output | Official source |
| --- | ---: | ---: | ---: | --- |
| `gpt-4o` | $2.50 | $1.25 | $10.00 | <https://developers.openai.com/api/docs/models/gpt-4o> |
| `gpt-4o-mini` | $0.15 | $0.075 | $0.60 | <https://developers.openai.com/api/docs/models/gpt-4o-mini> |
| `text-embedding-3-small` | $0.02 | Not mapped | Not applicable | <https://developers.openai.com/api/docs/models/text-embedding-3-small> |

Replit's official documentation describes AI Integrations as provider-public-price
pass-through, deducted from credits with no markup:
<https://docs.replit.com/features/integrations/replit-ai-integrations>.
This does not prove this account's credit allocation, discounts, taxes or invoice.

The readonly CLI includes this dated reference catalog separately from observed
usage. It deliberately does **not** calculate a supposed verified cost from it.
Cached input is a subset of input tokens; reasoning is a subset of output.
Neither should be charged twice. No dated-model/deployment alias or historical
tariff is inferred. No runtime worker or spending guard imports the catalog.

Other fetched official sources show why a blanket price would be unsafe:

- HeyGen API generation depends on avatar engine/type; legacy API plans can
  remain active, while newer API billing is separate from the normal product:
  <https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained>.
  A talking-photo payload does not establish which rate applies to this account.
- ElevenLabs pricing depends on model and commercial arrangement, and currently
  includes time-limited offers: <https://elevenlabs.io/pricing/api>.
  An advertised price for a new model is not the price of the configured model.

## What is still required before paid autonomous execution

1. Account-specific billing evidence: current plan/engine/region, currency,
   included credits and unit/rounding/overage rules; reconcile a representative
   usage export with a billing statement. No secrets are needed.
2. Missing billable units must be resolved from trustworthy provider evidence,
   not audio bytes, token guesses or elapsed time.
3. Durable paid-call identities, bounds, invoice/result reconciliation and
   restart/replay ownership. Best-effort telemetry is not a spending ledger.
4. Separately approved, bounded live pilot after the assisted regression gate.

Storage/recording transfer, hosting, subscription allocation, taxes and broader
infrastructure spend are not fully observed by this provider-attempt table.
Private-development usage remains private. Monthly tier prices/allowances and
autonomous paid-dispatch locks are unchanged. No migration is required for
these additive JSON counters; production instrumentation still requires the
previously documented operations-table migration before it can be relied on.

## Verification — 2026-10-06

- Full assisted gate passed: **303 API tests**, **34 frontend logic tests**,
  **five outbound-guard tests**, frontend typecheck and API build/structural
  checks. No new lint errors or format-debt files.
- Earlier focused AI/speech/avatar coverage passed 85 tests. The final gate
  includes eight new coverage tests, including WebSocket semantics, real SDK
  retry behavior with fake transports, privacy and constructor-wiring guards.
- One managed API restart completed recovery before listening. Health returned
  `ok`. Its existing operational security emails were sent as usual and the
  dormant-Stripe warning remained; no billing configuration was changed.
- The readonly one-day development report showed three SES attempts and three
  recipient submissions from that normal restart, with no unresolved attempts.
  These are operational notifications, **not** a real sourcing/interview cost
  sample. All verified-cost fields were null; account verification stayed false.
- No paid model/provider calls were made by the regression harness, no live
  autonomous pilot was started, and production was not migrated or published.
- Full regression logs: `/tmp/lexy-assisted-baseline-o2Zl93`.
