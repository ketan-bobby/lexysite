# Usage measurement foundation

For the current billing-dimension snapshots, tenant attribution, strict
tariff/allocation input contract and exact-period aggregate export, see
[internal usage economics](../../engineering/usage-economics-metering.md).
The workbook remains unchanged pending actual account bills.

This is internal observation, not pricing, an invoice, a billing entitlement,
or authorization for autonomous execution.

## Implemented coverage

- Shared `ai.ts` OpenAI/proxy and Azure chat clients record individual HTTP
  attempts, including SDK retries. Successful JSON receipts retain reported
  input/output/cached/reasoning tokens, with missing values left null.
- The default Whisper client records attempts, model and submitted audio bytes.
  Its existing text response format is unchanged: audio seconds remain unknown
  unless a provider actually reports them. Bytes and latency are not seconds.
- Default Azure STT attempts are observed. Azure and OpenAI interview TTS record
  attempts; synthesized input characters are observed, not asserted to equal
  invoice-billed characters.
- Start records are written before transport. A crash can leave a started row;
  this is unresolved, not a zero-cost success. Network errors are uncertain.
  Telemetry writes are ordered per attempt and each wait is capped at 250 ms.
  Persistence remains best-effort; process exit or DB failure can lose coverage.
- Interview runtime scopes use a server-loaded session's tenant when available.
  Other callers remain unattributed. Interview usage is intentionally
  unclassified, since it can include private candidate development.
- A platform-operations-only read-only CLI aggregates by day and resolved
  billing-root tenant. It reports missing units, retries, HTTP errors and
  unresolved attempts. Broken/cyclic ancestry remains unattributed.

```sh
pnpm --filter @workspace/api-server exec tsx src/scripts/vendor-usage-report.ts 30
```

## Privacy and deployment

No prompt, transcript, answer, audio, email, candidate/session ID, request URL,
credential/header or vendor response/request identifier is stored. Only
whitelisted usage counters and operational classifications are retained.

The additive migration is `lib/db/drizzle/0072_vendor_usage_attempts.sql`.
It enables and forces RLS with no application-role read policies. There is no
employer API or learning-analytics feed. The sink/report use the admin pool for
platform operations. Development and application SQL targets were both verified
as `heliumdb` before applying the migration to development. Production was not
migrated or published; explicitly apply the additive migration there through the
approved deployment process before relying on production telemetry.

## Expanded provider coverage

The subsequent provider pass covers the direct AI clients, embeddings, vision,
speech fallbacks (including iFlytek sessions), HeyGen, sourcing-adapter fan-out,
native SES retries and Graph outbound email. See
[provider coverage and public-rate evidence](provider-coverage-and-rates.md)
for exact boundaries and dated official rate sources.

## Not complete yet

- Account-specific charges and invoices are not verified. Avatar generation
  reconciliation, infrastructure/storage and subscription allocations remain
  incomplete even where transport observations now exist.
- Text-only/streaming responses may lack usage. Provider-reported speech
  duration is generally absent from existing responses. There is no invented
  duration, blanket sampling extrapolation or historical backfill.
- Billing-root aggregation does not make private developmental activity
  employer-visible. No per-candidate cost report is exposed.
- SDK retry count is recorded when supplied by its transport headers; absent
  headers remain unknown. These rows do not provide a durable idempotency key
  for paid replay or invoice reconciliation.
- Dated public OpenAI rate references have been checked against official model
  pages. They are not account-verified tariffs or invoice receipts. All measured
  costs remain explicitly unknown, including errors and interruptions. Earlier
  spreadsheet assumptions are not used as measured prices.
- Automatic retention for this operations table still needs the broader
  history-retention work; the CLI window limits reporting, not storage.

Consequently, monthly plan allowances are unchanged and autonomous spending
remains locked. Additional provider coverage and verified pricing/reconciliation
are still necessary before approving included usage or a live pilot.

## Verification — 2026-10-06

- Full assisted baseline: 287 API tests, 34 frontend logic tests and five
  outbound-guard tests passed; frontend typecheck and API build guards passed.
  Existing lint/format debt was unchanged, not widened.
- The seven new measurement tests cover whitelisted receipts, real SDK retry
  behavior against fake HTTP, uncertainty, Unicode character observations,
  asynchronous scope isolation, bounded/ordered slow persistence, durable
  database receipts and application-role denial. Fixture rows were cleaned.
- The focused transcription/measurement pass before the slow-persistence test
  was added passed 42 tests. The final full gate includes all seven measurement
  tests. The database library built successfully.
- The read-only report ran against development and honestly returned no measured
  usage initially; this is not a completed real-cost sample. No paid provider or
  model calls were made by the test harness.
- API restart completed; the sign-in page rendered. Existing startup security
  alerts sent operational emails and the pre-existing dormant-Stripe warning
  remains. This verification is not a claim of zero outbound activity or
  globally clean application logs. No billing settings were changed.
- A historical overlapping-startup baseline now explicitly reports the prior
  sourcing failure as "Run interrupted by a server restart". The final baseline
  ran after startup recovery settled and passed. Recovery behavior was not
  weakened or claimed fixed.
