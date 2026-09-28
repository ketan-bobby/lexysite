# Learning & Growth — course pilot

Stage B extends the private foundation documented in
[learning-pilot-foundation.md](learning-pilot-foundation.md). The approved scope is
in `documents/Lexy-Learning-Pilot-Final-Build-Plan.pdf`.

## Content and scope

- Customer Support Communication Foundations.
- Customer Support Communication in Practice.
- Each course contains six shared lessons, two voice-path lessons, and two
  chat/email-path lessons. An enrolment follows the shared lessons plus its chosen
  path; choosing a path does not enrol the candidate in a job.
- Lessons contain original teaching material, worked examples, a multiple-choice
  knowledge check, and an applied text response. Published time estimates describe
  these lessons, not the longer programme suggested in the original outline.
- Voice lessons use aloud self-practice and written reflection. They do not record
  audio, measure pronunciation, or claim to test listening from recorded audio.
- Objective-check feedback is deterministic. Applied responses receive a coaching
  example and a comparison checklist, not an AI grade or proficiency score.

The pilot is Lexy-funded. There is no candidate payment, credit wallet, enrolment
charge, or client training charge.

## Access and privacy

The existing server-side pilot switch and candidate allowlist apply. A candidate
must have saved interests, completed the existing career baseline, and confirmed
their current goals. A completed conversational baseline is a prerequisite, not
proof of support-role proficiency.

New course enrolment requires an explicit customer-service interest or a recognised
support-role preference. Do not force unrelated career interests into support
training. An existing enrolment remains resumable if interests later change, while
the baseline, current-goal confirmation, and pilot-access requirements still apply.

All course responses, drafts, feedback, and progress are candidate-private,
including against normal staff and administrator access. Do not feed them into
employer views, hiring scores, submissions, readiness badges, or discovery consent.
Candidate deletion must include the course records.

## Practice and completion policy

Draft saves preserve incomplete answers without counting an attempt. Submitting
requires every exercise response, a nonblank applied response of the documented
minimum length, and a correct knowledge-check answer to complete the lesson.
Length validation is only a form requirement: it does not assess answer quality.

Uncompleted exercises can be retried without a credit charge or attempt limit.
Completed lessons remain available for review; their saved completed responses are
read-only in this pilot. Course completion means all lessons in the selected path
have completed practice records. It does **not** mean demonstrated proficiency,
certification, employer readiness, or a guaranteed hiring outcome.

Saved drafts use revision checks. A stale save must not overwrite newer work:
preserve the local draft and offer an explicit discard-and-reload operation.

## Rollout and verification

Use additive SQL migrations with explicit RLS policies, FORCE RLS, foreign keys,
indexes, and grants. Never use `drizzle-kit push`. Apply migrations to the intended
development database first. Production access stays off until its migration and
cohort are deliberately configured; publishing must not be assumed to migrate the
project's external production database.

The course migration is
`lib/db/drizzle/0060_candidate_learning_courses.sql`, after the foundation's
`0059_candidate_learning_profiles.sql`. Both course tables require ENABLE and
FORCE RLS with the tenant policies installed, in addition to API owner checks.

```sh
pnpm --filter @workspace/api-server run test:learning-courses
pnpm --filter @workspace/api-server run test:learning-growth
pnpm --filter @workspace/api-spec run check-codegen
pnpm run typecheck:libs
pnpm --filter @workspace/lexy run typecheck
```

Core checks include the course integration test, generated-contract drift check,
shared-library and frontend typechecks, and a browser pass over enrolment,
draft save/resume, feedback, retries, and completion. Use disposable test fixtures;
never run a paid baseline interview to test these courses.

## Subsequent stage

The private post-course developmental reassessment is documented in
[learning-pilot-reassessment.md](learning-pilot-reassessment.md). It reports
current course-covered evidence without a pass/fail result, readiness label, or
fabricated comparison to the conversational career baseline.

Readiness thresholds, employer introduction video, and client submissions remain
later stages. Learning assessments remain private even when a separate,
candidate-approved client submission is introduced.