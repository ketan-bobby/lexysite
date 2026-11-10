# Nullable fields and missing-field cleanup

## Compiler result

API diagnostics: **191 → 174**, with **17 removed and zero new diagnostics**.
Remaining: 73 in non-test sources (including scripts), 101 in test code.
The full API typecheck is still not clean.

## Functional corrections

- The first pipeline configuration insert now retains `currentStage`, rather
  than silently defaulting it to null. Existing rows can still clear their stage.
- Career completion and recomputation check résumé presence on the canonical
  candidate row, scoped by the already-resolved self candidate ID. The career
  profile table has no `resumeUrl`; the old access always bypassed the
  résumé-specific missing-experience check.
- Fee display excludes nullable candidate/job references from lookup IDs and
  skips those lookups entirely when no real IDs exist. Non-hire adjustments and
  entries with deleted references retain their values and existing `"Unknown"`
  display fallback. Fee eligibility and charging rules are unchanged.
- Candidate data-export auditing uses the supported `in_app` channel.

## Contract corrections

- Conversation-draft tenant scoping accepts the complete caller identity needed
  by the shared data-scope helper; authorization logic is unchanged.
- Shared audit typing recognizes the existing tenant-settings subject.
- Target-company viewer history preserves nullable timestamp typing.
- Pending interview filters keep their existing enum values without a broad
  string-array cast.

## Verification

- 21 nullable-field, fee-eligibility and candidate-data-export checks passed.
  New checks execute current source with disposable query doubles; career
  recomputation is exercised over HTTP with controlled identity/merge helpers.
  These checks are not a live provider or real database acceptance claim.
- 67 recruiter ownership regression checks passed.
- Nine test batch/shard-planner checks passed with the new assisted-baseline
  entry.
- API build/security guards passed. Scoped lint: zero errors, eight warnings.
- Managed API restart succeeded and the login preview rendered normally. The
  existing dormant-Stripe configuration alert remains unchanged.
- All 37 long career-profile prompt/content literals match the checkpoint
  byte-for-byte; models, provider routing, prompts and scoring are unchanged.
- Cleanup tests used disposable records/query doubles; no historical Linx data,
  payment settings or access limits were deliberately changed by this work.

Evidence: `/tmp/api-null-fields-final.log`, `/tmp/null-fields-regressions.log`,
`/tmp/null-fields-ownership.log`, `/tmp/null-fields-lint.log`,
`/tmp/null-fields-build.log`, `/tmp/null-fields-planner.log`.

## Separate concurrency risks

The pipeline saver still uses a read-before-insert against a unique job ID;
simultaneous first saves need an atomic conflict-safe path. Private career
profile merge/write operations lack a stale-write check and need separate
concurrency verification. Neither is claimed fixed by this pass.
