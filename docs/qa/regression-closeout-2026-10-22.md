# Regression closeout — 2026-10-22

## Result

The assisted baseline completed in one uninterrupted execution, from
12:28:04Z to 12:40:18Z. All 30 reporting checks passed; none were skipped
or reported failed.

- 775 API tests across 66 files in 20 bounded batches passed.
- 161 frontend logic tests passed.
- 36 controlled-offer browser scenarios passed, with no failed/unrun scenarios.
- 33 baseline planner checks and five egress-guard checks passed.
- Strict frontend and API typechecks passed.
- API build and its existing access-control/privacy/rubric guards passed.
- Repository lint reported zero errors; this does not mean zero warnings.
- Repository formatting reported zero differing files.

The machine-readable journal for this execution is
`/tmp/lexy-assisted-baseline-4D32Ym/summary.json`; that path is temporary.
This document retains the outcome independently of temporary files.

## Corrections

The Project workflow launched eight validation workflows in parallel.
Several checks duplicate work inside the assisted baseline, and browser/compile
load competed with shared-database fixtures. The Project workflow is now
sequential, validated through the configuration replacement mechanism.
All eight commands remain present; no checks, assertions or permissions
were removed or relaxed. The newly configured complete Project sequence
was not rerun because it would duplicate the completed gate.

Two scheduling candidate-picker files were reformatted. Their logic did not
change. The baseline's frontend tests, typecheck and final formatting check
include those corrected files.

The earlier offer navigation timeout did not recur in the baseline's own
isolated browser run. No product change or timeout increase was needed.
An additional standalone offer run, queued before confirming that the baseline
already included it, was stopped as redundant. Its interrupted result is not
counted as a passing run; the complete baseline browser result is the evidence.

## Boundaries

This closes the interrupted local regression gate, not every product gap or
production acceptance requirement. Browser scenarios use synthetic intercepted
responses; they do not prove real email delivery or external ATS/calendar sync.
These validation/configuration changes did not modify models, prompts, provider
routing, pricing, pilot entitlements, production schema or historical Linx data.

Candidate self-booking, authorized panel availability and connected external ATS
sync remain separate builds/acceptance units. Existing six-stage synthetic pilot
evidence must not be represented as an independently verified real hire,
identity clearance or production certification.
