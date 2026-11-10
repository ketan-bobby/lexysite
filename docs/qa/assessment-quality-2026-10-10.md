# Native assessment-quality verification

## Result

**93 targeted tests passed:** 66 deterministic unit/capture tests, 17 temporary-database
queue/recovery tests, and 10 admission/network-egress checks after resource recovery.
Frontend typecheck passed. Targeted lint reported zero
errors and 19 existing hook/type warnings. API managed restart completed its
build and guard checks successfully.

## Closed gaps

- Missing, non-numeric, non-finite and out-of-range grades remain unscored. They
  are not coerced to zero or clamped into a confident score.
- Missing answer capture is distinct from a candidate's explicit non-answer.
  Genuine assessed zero remains zero.
- No summary is generated or saved without a usable graded candidate answer.
  A model-generated headline cannot replace absent grades.
- Invalid grading cannot enqueue downstream hiring intelligence/match work.
  A controlled retry with valid evidence recovers through the existing queue.
- Headline scores derive from actual valid answer grades.
- Quoted evidence must occur in captured candidate answers, not interviewer
  questions. Straight/curly quotation marks and ordinary contractions are tested.
- Partial/missing grading, headline disagreement and conflicting recommendations
  remain explicit human-review concerns. They are not automatic hiring cutoffs.
- Interview detail, interview PDF and workflow evidence share the same warnings.
  Newly generated employer evaluations preserve server-derived quality warnings
  even when human narrative edits clear the ordinary concerns list.
- Workflow evidence bindings include answer evidence so changed evidence cannot
  silently reuse an earlier reviewed binding.

## Existing safeguards verified

Dense, concise answers outrank padded answers in the deterministic readiness
heuristic; numeric spam and repeated filler do not earn high credit. The
space-less-script regression remains intact.

Weak signal and capture failures require explicit review; audio-only continuous
capture retains its final tail and microphone, and capture diagnostics are
content-free client reports, not authoritative speech or grading evidence.

Private temporary PostgreSQL tables and mocked providers exercise the real
HTTP/queue/worker handoff, retries, duplicate completion, downstream delivery
and terminal-stage preservation. Fixtures close and discard their temporary
tables. No real email/provider request escapes that fixture.

## Scope and limits

Assessment prompt literals in every changed assessor file were compared with
the prior source and are unchanged. Model selections, routing, deployments,
rubrics and language configuration were not changed. No historical Linx
interview, evaluation or employment record was reassessed or rewritten.

These checks validate evidence handling and orchestration, not universal model
accuracy. Unquoted or paraphrased narrative claims still need human review;
formal output checks cannot establish their semantic truth. Multilingual grading
accuracy needs independently reviewed answer samples and separately authorised
calls to the existing providers. No live interview was required for these checks.

## Environment recovery

Initial validation commands stalled without output while older repository-wide
checks remained resident. Pausing validation-only workflows restored the runner.
Stale app listeners conflicted with managed service ports; only those exact
listeners were stopped, then the existing API and Lexy workflows were restarted.
No replacement workflow, dependency or environment-variable change was made.

Older repository-wide workflow results include timeouts and failed checks from
the resource-constrained run. They were not rerun as a full suite, so this report
does not claim a globally passing baseline. The admission and network-egress
checks that failed during that run pass when rerun in the recovered environment.
The unauthenticated pipeline-status polling exception visible in startup logs
is outside this assessment change; no bypass was added to suppress it.

The Lexy sign-in preview renders after recovery. Assessment warning behavior
behind staff sign-in is verified by shared-policy tests, source integration
checks and frontend compilation, not by that public preview image.
