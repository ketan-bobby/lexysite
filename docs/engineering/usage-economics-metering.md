# Internal usage economics

## Boundaries

This is measurement, not billing, an allowance recommendation or spending
authorization. Plan prices, subscription fees, commercial contracts, credit
activity, paid-dispatch locks and stabilized models/prompts/routes are unchanged.
No provider calls, top-ups, Stripe setup or publishing are needed to run the
tests or report.

The sole cost-attempt source is `vendor_usage_attempts`. SDK retries each receive
a new identity; a start and its final/late receipt update the same identity.
Started, HTTP-error, timed-out and uncertain attempts are unknown exposures,
never free. A receipt is not a verified dollar charge. Missing persistence is
reported in server warnings; the report cannot claim complete account coverage.
Do not replay a paid action to fill a missing receipt.

`stt_transcribe_events` remains a listening-quality outcome table. It can record
one final outcome after several vendor attempts and is publicly readable.
Adding private billing dimensions there would leak data and double-count
fallbacks. STT billing observations instead live in the operations-only ledger,
which has forced RLS and no application-role policies. Likewise,
`credit_usage_events.units` are product activity, never vendor dollars.

## Collection

- All existing OpenAI/Azure SDK constructors retain metered transport, including
  the main text/JSON helpers, conversation calls, embedding, grading and direct
  career-profile calls. Input/output/cached/reasoning token receipts are
  whitelisted; cached input is part of input and reasoning is part of output.
  Requested alias/deployment and returned model/version are distinct.
- Authenticated request labels come from the validated current user tenant,
  not a requested tenant ID. Job matching and resume screening override with the
  resolved job tenant. Queue work uses the claimed job tenant. Bound workflow
  scope survives nesting; scopes from different tenants never inherit it.
- Cookie interview routes gain attribution only after session authentication.
  Public/cookie interview usage stays unclassified/private, including
  conversation, grading, STT and TTS. Candidate HTTP paths use the private
  development bucket. No candidate/session ID, score or developmental content
  goes in an economics observation or employer signal.
- Root billing tenant, country and plan are snapshotted at attempt start.
  Missing ancestors, cycles or missing country/plan stay null. Legacy rows
  have unknown historical plan/country; the report does not invent them.
- Binary TTS retains input character counts but these are observations, not
  asserted billed characters. ElevenLabs `character-cost` is retained separately
  when returned. Explicit billed seconds/characters/credits are retained from
  usage receipts; processed audio seconds and input bytes are not substitutes.
- HeyGen generation, polling and upload operations are separate. Explicit
  render billing units and opaque render receipt IDs may be retained; repeated
  status polls do not add another render charge. Produced video length is not
  asserted to be billed duration.
- Text-format STT and providers that return no billing receipt remain unknown.
  We do not change response formats, speech routing, retry behavior or models
  just to obtain extra telemetry.
- Logical account references can be supplied with `meteredFetch` observations
  after operations establishes the account mapping. No account is inferred from
  an API key, hostname or provider brand. Until mapped, tariffs cannot match.
  For a verified single-account transport, operations may configure the
  non-secret `VENDOR_USAGE_ACCOUNT_<UPPERCASE_PROVIDER>` alias (for example
  `VENDOR_USAGE_ACCOUNT_OPENAI_DIRECT`). No aliases are configured by this task.
  Multi-account Azure STT deliberately ignores provider-level aliases: each
  account needs its own explicit observation reference. Never map multiple
  accounts onto one alias. Mapping affects future observations only.

Only fixed labels, numeric observations and whitelisted opaque receipt/account
references are retained. No prompts, transcripts, candidate names, email
addresses, resume text, profile URLs, headers, credentials, audio or video bytes
are stored here. Account references are not credentials.

## Read-only report

Run from the workspace with platform-operations access:

```
pnpm --filter @workspace/api-server exec tsx src/scripts/usage-economics-report.ts \
  2026-10-01T00:00:00Z 2026-11-01T00:00:00Z \
  ../../docs/analysis/sourcing-economics/accounting-evidence.empty.json
```

The optional fourth argument is an exact leaf tenant filter (not subtree
authority). The pure aggregation API also accepts an explicitly authorized set
of leaf tenant IDs. Filtering occurs before billing-root aggregation; access to
a child cannot expose a sibling. No employer or candidate HTTP endpoint exposes
this report. Do not upload it into candidate evaluation or learning signals.

Output has half-open UTC period boundaries, leaf tenant/country/plan groups,
billing-root totals, retry/error/missing-usage counts, observed units, separately
identified billable receipt units, partial account-verified tariff calculations,
unknown-amount attempt counts, hypothetical public-rate estimates and separate
invoice/support/infrastructure allocations. Missing amounts are null or absent,
not zero. A genuine evidenced zero is supported.

Tariff calculations are not settled invoice charges, even with account-verified
rates. They exclude unknown attempts, discounts, taxes and other reconciliation
differences. Partial known totals are always accompanied by unknown counts.
Duplicate attempt identities and provider receipt identities cannot multiply
billable units; video polls and quality/activity tables are not additional
charges. Alternative speech/render units (e.g. credits and seconds) must have
one confirmed billing basis, not several added together.

## Evidence input contract

The strict, validated local JSON contract is in
`src/lib/usage-economics.ts` (`economicsEvidenceSchema`). Empty input is valid;
the included JSON template intentionally contains no made-up prices or costs.
Unknown keys/free-text notes are rejected. Keep source bills and personnel
records in their existing approved secure system; use opaque references here.

Tariff rows require:

- unique `id`, provider, verified logical `accountRef`, exact model/version
  (or null for non-model providers), operation and billing unit;
- currency, integer `amountMicros`, positive integer `perUnits`;
- inclusive `from`, exclusive `to`, opaque `evidenceRef`, and `verifiedOn`.

An exact matching account/model/operation/unit and time interval is mandatory.
Missing account mapping, missing usage, expired rates and conflicting overlapping
tariffs produce unknown amounts. No public price becomes an account tariff.

Allocation rows cover **existing** vendor commitments, infrastructure and direct
support. They require unique source/invoice-line identity, category, currency,
nullable integer total micro-units, evidence reference, precise period,
allocation basis and every recipient's measured integer basis units.
Supported bases are measured requests/seconds, storage byte-days, support
minutes and documented contract shares. Use a null tenant for overhead.
Include foreign/overhead recipients in the denominator even for a leaf export.
Do not store staff names, payroll detail or support-message content.

Treatment is `incremental`, `already_in_tariff` or `hypothetical`.
Incremental allocation requires invoice evidence and amount. Covered commitments
are excluded to avoid counting the same charge as both tariff and fixed cost.
Hypothetical amounts are separate, not account-verified. Duplicate invoice-line
sources are rejected. Partial-period invoices are not guessed/prorated: supply
the appropriate explicit period allocation. Allocation arithmetic uses exact
integer fractions (`numeratorMicros` / `denominator`) and preserves currencies;
there is no guessed FX rate or floating-point rounding.

## Upgrade and verification

Apply `lib/db/drizzle/0076_usage_economics_labels.sql` through the existing
reviewed migration process before activating the new labels in each environment.
It extends only the label constraint; it does not add app-role policies or
alter accounting authority. No generic Drizzle push: it can strip security.
Publishing alone must not be assumed to migrate an external database.

```
pnpm --filter @workspace/api-server run test:usage-economics
```

Tests use fake transports and synthetic rolled-back database schemas. The egress
guard denies real HTTP integrations. Upgrade tests start from the original
ledger, exercise the real durable writer, verify immutable billing dimensions,
reject arbitrary labels, and verify forced RLS/application-role denial.

The economics workbook remains unchanged. Later, reconcile these observations
against actual provider bills, verified account tariffs, commitments,
infrastructure bills and direct-support allocation inputs; re-run
`docs/analysis/sourcing-economics/build_model.py` with those inputs. Do not
interpret incomplete coverage as a safe allowance, enable paid autonomy, or
change customer contracts from this report.
