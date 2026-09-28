# Stage D — private Voice Progress Interview

Stage D adds a structured, candidate-private voice progress cycle. A candidate
first completes Lexy's developmental voice baseline (Form A), then completes
the relevant support-communication training, and finally completes a fresh
equivalent voice interview (Form B).

The paired forms cover the same five communication dimensions with new prompts.
They are compared only when the comparison-family, rubric, and deterministic
evaluator versions match exactly. A changed version fails closed as
`not_comparable`.

Lexy stores only the candidate's editable transcript text. The cycle has no
audio, recording, blob, storage key, or provider fields. Browser speech services
may process dictation under browser settings, but audio is not sent to or stored
by Lexy.

Reports describe observed differences, not proof that training caused a change.
They do not produce pass/fail, percentages, hiring scores, readiness,
proficiency, certification, employer-sharing, application, ranking, or
intelligence outputs. The dedicated tables are not connected to job/application
interview tables.

Migrations `0063_candidate_learning_voice_progress.sql` and the additive
`0064_candidate_learning_voice_owner_rls.sql` must be applied to development
first. Production remains untouched until the pilot cohort and migration
rollout are deliberately approved. Migration 0064 adds candidate-owner RLS and
training completion evidence without rewriting existing enrollment history.

## Candidate API

All endpoints are under `/api/portal/learning-growth/voice-progress`, are
candidate-owner authenticated, and return `Cache-Control: private, no-store`.
The server derives candidate and tenant identity from the session.

- `GET /` returns eligible voice courses and cycle summaries. Summaries explain
  whether a baseline, post-baseline training completion, progress interview, or
  report is needed.
- `POST /` with exactly `{ "courseId": "..." }` starts or resumes Form A.
- `GET /:cycleId` returns the current phase's prompts, transcript progress, and
  privacy disclosures.
- `PUT /:cycleId/turns/:taskKey` with `{ revision, response, action }` saves a
  draft or immutably submits a turn.
- `POST /:cycleId/start-progress` accepts only `{}` and requires a matching
  completed voice enrollment whose completion timestamp is strictly after the
  frozen baseline timestamp.
- `POST /:cycleId/complete-training-review` accepts only `{}` for a course
  completed on or before the baseline; it records the candidate's explicit
  post-baseline review confirmation without changing enrollment history.
- `GET /:cycleId/report` is available only after Form B completes and is
  rendered from the frozen baseline, progress, and comparison snapshots.
- `POST /:cycleId/training-review` starts or resumes a tracked, lesson-only
  review for courses completed before the baseline; `GET` returns its private
  progress and `PUT /:cycleId/training-review/lessons/:lessonId` marks one
  voice-path lesson reviewed. Completing all lessons unlocks progress and
  awards 10 non-monetary learning credits.
- `GET /api/portal/learning-growth/achievements` returns private recognition
  points, badges, recent activity, and learning milestones. Learning credits
  have no cash value, cannot be transferred or purchased, do not expire, and
  cannot be reused as billing credit.

The cycle state sequence is `baseline_draft` → `training_required` →
`progress_draft` → `completed`. Existing career interviews and Stage C reports
are never used as the baseline.
## Candidate UX

The frontend experience for the Voice Progress cycle and Achievements ensures a safe, encouraging environment:

- **Achievements & Learning Credits**: Displayed on the main Learning & Growth plan. Credits are explicitly labeled as having no cash value and no hiring impact. Badges use standard UI icons (no emojis) for broad accessibility.
- **Training Review Flow**: When a candidate has already completed a course prior to starting a voice baseline, they enter "review" mode instead of retaking the course from scratch.
  - They launch the review from the Voice Progress Home.
  - The course detail view detects the active `voiceCycle` query parameter.
  - Interactive exercises are rendered as read-only (disabled) to preserve their original completion history.
  - A prominent "Course Review" panel allows the candidate to mark each specific lesson as reviewed.
  - On the final lesson, the candidate receives completion feedback and is seamlessly routed back to start their post-training progress interview.
- **Accessibility**: No gamification or competitive leaderboards. Keyboard focus is respected. Reduced-motion and screen-reader accessibility are preserved via standard component primitives.
