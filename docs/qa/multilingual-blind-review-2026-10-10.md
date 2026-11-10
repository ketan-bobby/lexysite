# Multilingual blind-review preparation

## Implemented

- A reusable offline pack generator builds 40 shuffled, opaque-ID samples from
  the retained ten-language diagnostic. The reviewer CSV contains questions,
  answers and English meaning references, but no AI grades, model feedback or
  expected answer-class labels. The separate guide includes the unchanged
  grading rubric.
- A separate manifest binds sample content, the source AI result digest,
  grading contract and fixture corpus. Keep it and comparison reports away
  from reviewers; share only the CSV and guide.
- Reviewers provide an anonymous alias, self-attested language competence and
  blinding, translation judgment, integer score or explicit unscored state,
  and rationale. Untouched rows remain unreviewed.
- The comparator validates the same saved AI baseline and rejects changed
  text/pack bindings, stale corpus/contracts, altered AI scores, malformed
  ratings and duplicate reviewer/sample submissions.
- Missing capture remains unscored, never zero. Genuine zero ratings survive.
  Unqualified/unblinded or translation-concern submissions do not establish
  eligible coverage. Two eligible aliases per sample are required for complete
  submission coverage, not proof of independent people.
- Differences or reviewer disagreement over 15 points are flagged for human
  discussion. This diagnostic threshold does not replace the production
  rubric or edit any saved candidate grade, hiring decision or workflow.

## Verification and current status

Seventeen offline tests, the targeted strict TypeScript check, changed-source
lint and the frozen-rubric guard passed. The configured `multilingual-grading`
validation workflow also completed successfully without provider calls.

The actual pack was generated from the saved live result. Comparing its
untouched CSV produced **awaiting-human-review**, zero submitted reviews,
incomplete coverage and `certification: false`. No human ratings were invented.
Tests use explicitly synthetic submissions only.

The manifest and comparison JSON have mode 0600. Generated files are excluded
from Git and deployment output. No production service code or configuration
changed; only the offline validation workflow was restarted.

## Operation

Run within the API package via the workspace filter. Relative input paths are
resolved from `artifacts/api-server`, not the workspace root:

```sh
pnpm --filter @workspace/api-server exec tsx scripts/review-multilingual-grading.mts \
  prepare ../../generated-artifacts/multilingual-grading/<saved-run>.json

pnpm --filter @workspace/api-server exec tsx scripts/review-multilingual-grading.mts \
  compare <manifest.json> <same-saved-run.json> <reviewer-a.csv> [reviewer-b.csv ...]
```

Incomplete/provisional comparisons intentionally return nonzero and write an
explicit status in `comparison.json`. A command wrapper can normalize numeric
child exit codes; inspect the result status, not an assumed numeric passthrough.

Source labels remain honest: reviewer identity, competence and blinding are
self-attested, not authenticated staff approval or verified independence.
The retained legacy AI result lacks a fixture digest and usage receipts.
Its comparisons remain provisional and its costs unknown. Future grading
diagnostics now record the fixture digest; no new paid diagnostic was run here
and no historical result was rewritten.

Actual human review, audio/whole-language testing and independently established
calibration remain pending. Models, providers, prompts, rubrics, commercial
tiers, external sourcing and original Linx work orders remain unchanged.
AWS-dependent verification remains deferred.
