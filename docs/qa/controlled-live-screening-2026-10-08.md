# Controlled native screening acceptance

## Observed live result

The existing isolated pilot work order `WO-2026-LIVE-MAIN-0013` used its separate
one-hour screening authority and acknowledged unknown provider charges.
Automatic pipeline execution remained off. One canonical fictional profile was
assessed; there was no résumé and no other candidate was targeted.

At 2026-10-08 16:57 UTC, the normal authenticated workflow execution endpoint
returned a completed screening run. The persisted job-scoped source contained:

- Score: 85/100.
- Recommendation: hold.
- Confidence: medium.
- Matching supplied skills: TypeScript, Node.js and PostgreSQL.
- Missing information: location, current company and years of experience.

The provider receipt recorded `openai_proxy`, the existing `gpt-4o` model,
HTTP 200, one observed API request, 587 input tokens and 153 output tokens.
Cost status remained unknown. No invoice amount is asserted.

The workflow was explicitly marked `review_required`, with the saved assessment
and its limitations recorded. All five subsequent steps remain pending. This
does not approve advancement, verify identity or establish real résumé evidence.

## Contact and retry safety

After the API server restarted, another execution request was rejected with
HTTP 409 by the durable claimed-action guard. It did not rerun screening.
The profile remained synthetic and identity pending. The work order had zero
outreach messages and zero interview plans, with `auto_run=false`.

## Attribution repair

The original time-correlated provider receipt lacked tenant/workflow attribution.
It is preserved unchanged; temporal correlation is not a unique attribution
key, and the successful call was not repeated merely to repair metering.

Future explicitly bound native actions now establish vendor usage scope with
the validated workflow tenant and an identifier containing workflow and step.
Assisted calls are unchanged, concurrent scopes are isolated, and costs remain
unknown until independently established. No models, prompts, routing or
deployment configuration changed.

Two focused metering tests and the production screening-wrapper integration
test passed. The wrapper test covers valid, zero-work and malformed grades.
The changed backend modules introduced no additional TypeScript diagnostics;
the previously documented broader API TypeScript debt remains.

No interview, outreach, live identity-provider check or hiring acceptance is
claimed by this screening milestone.
