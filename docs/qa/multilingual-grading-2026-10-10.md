# Multilingual answer-grading diagnostics — 2026-10-10

## Scope and outcome

One live **synthetic, unreviewed, text-only** diagnostic used the current queued
answer-grader templates extracted from the frozen source, the existing
`generateJSON` routing/defaults, and no interview focus directive.

Thirty non-empty examples returned valid grades; ten missing captures stayed
null without a provider call.

| Language | Detailed answer | Generic answer | “I don't know” |
|---|---:|---:|---:|
| English (US) | 95 | 15 | 10 |
| Hindi | 95 | 15 | 10 |
| Telugu | 95 | 15 | 10 |
| Tamil | 95 | 15 | 10 |
| Bengali | 95 | 15 | 10 |
| Kannada | 95 | 15 | 10 |
| Marathi | 90 | 25 | 10 |
| Spanish (Spain) | 95 | 25 | 10 |
| Arabic | 95 | 25 | 10 |
| French | 95 | 25 | 10 |

All detailed translations stayed within five points of the English example.
Refusals remained under the existing rubric's 20-point bound. Generic answers
remained below its average band. Returned feedback used the selected language
on inspection; this is not independent native-speaker review.

The routing catalog contained 51 entries, including regional variants/aliases.
Only ten were exercised live. Arabic used the existing OpenAI fallback because
Azure OpenAI was not configured in this diagnostic process. That does not
establish Azure deployment availability or say anything about Azure Speech/TTS.

## Accounting limitation and repair

The original live run's overall verdict was **diagnostic-failed** because the
new diagnostic usage label was rejected by the database area constraint. Its
grades passed, but usage receipts did not persist. Do not claim complete
telemetry or zero cost.

The harness now uses an allowed `ai_interview` label, putting diagnostic run,
locale and case identity in the workflow-ID segment. No schema, constraint or
production metering behavior was changed. A simulated transport with the real
durable sink verified one successful receipt with cost still unknown; its exact
temporary row was deleted. No paid calls were repeated to repair history.
The original live JSON remains unchanged in the ignored generated-artifacts
directory. Future reports distinguish grading and receipt verdicts.

## Repeatable checks

```sh
# Seven offline cases, no provider calls.
pnpm --filter @workspace/api-server run test:multilingual-grading
# Frozen grading-contract guard, no provider calls.
pnpm --filter @workspace/api-server run check:rubric-lockstep
# Simulated transport, temporary real DB receipt, no provider calls.
pnpm --filter @workspace/api-server run check:multilingual-grading --check-metering
# No credentials/provider calls; saves planned coverage and source hashes.
pnpm --filter @workspace/api-server run check:multilingual-grading --dry-run
# Explicit live diagnostic: 30 logical grading calls plus normal SDK retries.
# Never run automatically as a build gate.
pnpm --filter @workspace/api-server run check:multilingual-grading --live
```

The seven offline cases plus 19 adjacent assessment-warning/summary tests
passed. Coverage includes live-template rendering, retained facts, valid zeros,
malformed/provider-error grades remaining null, no call for missing capture,
strict refusal/parity bounds, valid scope labels, and evidence/review warnings.
One existing source assertion became whitespace-tolerant without weakening its
required arguments. Targeted strict TypeScript and changed-source lint passed.
The shared JS extractor gained declarations; the speech metadata type now
allows the already-configured `azure` value, with no runtime/provider change.
The unrelated backend-wide typing backlog is not claimed fixed.

The live harness saves incremental progress and compares detailed-answer
scores. Full grading-contract and language-provider source hashes matched
before/after the live run. The later metadata typing correction was type-only.
The managed API build/security guards passed and the service restarted.

## Remaining evidence

The offline review pack and comparison checks are now implemented; see
`multilingual-blind-review-2026-10-10.md`. The generated pack still has zero
actual human submissions. Availability of a review tool does not close the
independent-calibration gap.

- Independently reviewed translations and human-scored answer samples.
- More question types, repeatability, and all exposed language choices.
- Actual microphone/STT/TTS and conversational-adaptation tests.
- Preferred-provider availability where an existing fallback handled a call.
- Receipts from a future authorized live run and separate bill reconciliation.

No existing candidate, completed interview, Linx work order, hiring decision,
offer, fee, model, provider configuration, prompt or rubric was rewritten.
No candidate outreach/interview/offer message was sent by this diagnostic.
AWS-dependent checks remain deferred.
