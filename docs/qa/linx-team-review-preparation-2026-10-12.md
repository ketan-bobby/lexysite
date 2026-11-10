# Linx team acceptance preparation

## Prepared downloads

The reviewer-facing files are in
`generated-artifacts/linx-team-review-2026-10-12/`:

- `reviewer-template.csv`: unchanged blind pack, 40 untouched samples across
  ten selected languages. Each person returns their own copy.
- `review-guide.html`: existing guide with the frozen grading rubric.
- `acceptance-checklist.html`: printable coordinator worksheet, language
  assignment matrix, six-stage evidence checks, and explicit deferred gaps.

Assign two different competent, blinded reviewers per language. The same
multilingual reviewer may cover multiple languages. Full submission coverage
requires two eligible reviews per sample, including explicit unscored entries
for missing capture. Aliases do not independently establish reviewer identity.

Only the CSV and guide should go to language reviewers. The coordinator keeps
the original manifest, AI result, and comparison reports private. The worksheet
contains no AI grades or expected sample-class labels.

## Integrity and current status

The existing offline comparator validated the original manifest, same saved
baseline, current fixture expectations, and frozen grading-contract binding.
The expected result was `awaiting-human-review`, zero submitted review rows,
and `certification: false`. An incomplete comparison intentionally exits
nonzero; the explicit result status was inspected rather than treating the
package wrapper's exit code as a completed calibration result.

The exported CSV and guide are byte-identical to the original reviewer files.
The CSV has 40 samples, ten locales, and all six reviewer fields blank.
Only three intended reviewer/coordinator files are in the download directory;
no manifest, AI result, comparison report, or credential was copied there.

Locales: Arabic, Bengali, English (United States), French, Hindi, Kannada,
Marathi, Spanish (Spain), Tamil, and Telugu; four samples per locale.

## Return and comparison

Reviewers return separate UTF-8 CSV files with immutable columns intact.
Use the existing offline command with the private inputs retained locally:

```sh
pnpm --filter @workspace/api-server exec tsx scripts/review-multilingual-grading.mts \
  compare /absolute/path/to/original/manifest.json \
  /absolute/path/to/same-saved-baseline.json \
  /absolute/path/to/reviewer-a.csv /absolute/path/to/reviewer-b.csv
```

Inspect the generated comparison status. Preserve incomplete coverage,
translation concerns, unscored capture, and disagreement flags for actual
human resolution. No production score, candidate outcome, or workflow
approval is updated by comparison.

The original baseline's missing fixture binding and usage receipts remain
explicit; human submissions cannot retroactively repair them. Results remain
provisional, not independently established language calibration. The text
pack does not verify speech or all exposed language choices.

No paid model/provider call, candidate email, invitation, offer, billing
activation, application edit, workflow restart, LLM configuration change, or
historical Linx work-order change was performed for this preparation.
AWS and employer-authorized ATS acceptance remain deferred.
