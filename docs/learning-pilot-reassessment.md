# Learning & Growth — developmental reassessment

Stage C adds a private post-course reassessment to the foundation and course pilot
described in [learning-pilot-foundation.md](learning-pilot-foundation.md) and
[learning-pilot-courses.md](learning-pilot-courses.md). The approved programme
scope is in `documents/Lexy-Learning-Pilot-Final-Build-Plan.pdf`.

Stage D adds a separate structured Voice Progress Interview cycle. See
[learning-pilot-voice-progress.md](learning-pilot-voice-progress.md) for its
paired baseline/progress forms and comparison safeguards.

## Product boundary

- Completing either support-communication course unlocks a reassessment for that
  course and the path fixed at enrolment.
- Each reassessment contains four fresh, versioned tasks covering only skills
  taught in that course and path.
- The report describes current observed evidence using the developmental levels
  Emerging, Developing, Consistent, and Not observed.
- Recommendations link back to relevant course lessons for further practice.
- Candidates may repeat a completed reassessment; each completed attempt keeps an
  immutable, versioned report.

This release has no pass/fail result, percentage score, proficiency claim,
readiness threshold, certification, or job-ready label. It does not affect hiring
scores, applications, ranking, discovery, submissions, introductions, or employer
views.

## Honest comparison policy

The existing career baseline did not capture a structured task comparable to the
new reassessment. Reports therefore show current evidence only and state why a
before/after comparison is unavailable. Do not infer a baseline score from an
interview summary, career profile, or general conversation.

A future comparison may be shown only when both observations use a compatible
rubric and genuinely comparable task evidence. Even then, describe the observed
change without claiming that the course caused it.

## Voice-path evidence

Voice-path tasks ask the candidate to speak a response aloud and save the resulting
text. Browser dictation is optional; typing is always available. Lexy does not
receive or store audio, although the browser's speech service may process audio
under the candidate's browser settings.

Only the editable saved text is assessment evidence. The pilot does not measure
pronunciation, accent, fluency from audio, or listening ability.

## Access, privacy, and integrity

The Stage A pilot switch, candidate allowlist, completed career baseline, and
current confirmed goals remain mandatory. The relevant course must have a real
completed enrolment. A changed support interest does not invalidate an already
completed course.

Assessment tasks, responses, developmental levels, evidence, and reports are
candidate-private, including against normal staff and administrator access. API
identity comes from the candidate session, and all reads and writes repeat
candidate and tenant ownership predicates in addition to database RLS.

Drafts use optimistic revisions. Submitted tasks are immutable. The final task
write, complete-task check, evaluation, report snapshot, and assessment completion
occur in one transaction. Completed reports render from their frozen snapshot, not
from mutable course or assessment catalogs.

## Evaluation

The rubric and task catalog are hand-authored and versioned. Evaluation is
deterministic and uses only the submitted text: required scenario facts,
observable communication choices, and unsupported promises. Minimum response
length is submission validation only and is not treated as evidence of quality.
No AI or external provider is called during evaluation.

## Data and rollout

The additive development migrations are:

- `lib/db/drizzle/0061_candidate_learning_assessments.sql`
- `lib/db/drizzle/0062_candidate_learning_assessment_ownership.sql`

The parent and task tables use ENABLE and FORCE RLS, tenant policies, explicit
grants, candidate/tenant foreign keys, and cascading candidate deletion. The
second migration binds every task to the same candidate and tenant as its parent
assessment.

Never use `drizzle-kit push`. Production access remains off until both migrations
are applied to the intended production database and a deliberate candidate cohort
is configured.

```sh
pnpm --filter @workspace/api-server run test:learning-assessments
pnpm --filter @workspace/api-server run test:learning-growth
pnpm --filter @workspace/api-server run test:learning-courses
pnpm --filter @workspace/api-spec run check-codegen
pnpm run typecheck:libs
pnpm --filter @workspace/lexy run typecheck
```

## Still outside this release

- A comparable pre-course structured assessment and before/after claim.
- A readiness threshold, certification, employer badge, or hiring qualification.
- Employer access to learning records.
- Recorded-audio assessment, pronunciation scoring, or listening assessment.
- Automatic employer introduction or client submission based on learning data.
