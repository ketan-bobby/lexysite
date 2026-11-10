# Broader regression verification

## Retained complete functional results

The assisted regression run completed all functional, compilation, build, and
lint phases. Its original overall result failed only on four formatter
violations; that historical result has not been rewritten.

- API: 618 passing cases across 56 test files in 17 bounded batches.
- Frontend logic: 55 passing cases.
- Batch/shard planner: 9 passing cases.
- Test egress guard: 5 passing cases.
- API and frontend strict typechecks: pass.
- API build and source safety/privacy/rubric guards: pass.
- Repository lint: zero errors. Existing warnings remain; this is not a claim
  of warning-free code or a complete security audit.

Separate configured validation workflows also completed successfully:

- Transcription, Azure pool, and admission checks: 73 passing cases.
- Multilingual grading/review checks: 17 passing cases.
- Rubric lockstep: three copies match the frozen calibration contract.
- Recruiter avatar/intro-video access checks: 16 passing cases.

These counts describe individual runs, not an additive count of unique tests:
some separately configured checks overlap the assisted regression run.

## Formatter remediation

Corrected formatting in the recording-segment test, fee-ledger route, and two
live-pilot scripts. No logic, model, provider, prompt, language routing,
entitlement, offer approval, billing activation, or live-pilot behavior changed.

Before applying the patch, normalized TypeScript-emitted JavaScript was compared
before and after formatting and was identical for all four files. The applied
files were then checked against those verified formatter outputs.

Post-remediation checks:

- Actual repository `format:check` workflow: pass.
- API build and all build guards: pass again.
- Changed-file ESLint: zero errors.
- Patch whitespace check: pass.
- Managed API workflow restarted once and is serving.

The 618 API cases were not needlessly rerun for an execution-equivalent style
patch. The old assisted-run failure remains visible in its historical receipt;
current formatting success is recorded by the separate formatter workflow.

## Limits

This is automated regression evidence, not live end-to-end provider acceptance.
Neither live-pilot script was executed. Transcription negative cases emit
simulated provider-failure logs; those logs are not evidence that real Azure,
OpenAI, Deepgram, or ElevenLabs credentials are broken.

The existing dormant-Stripe configuration alert remains unchanged. Restarting
the API retained its normal startup alert behavior; no candidate invitation or
pilot offer was initiated by this verification.
