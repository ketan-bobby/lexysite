# Learning & Growth pilot — foundation

This documents Stage A of the graduate learning programme. It adds a private candidate
journey without changing existing hiring, interview, application, or client
workflows.

## Delivered boundary

- Candidate career interests and immediate role preferences are separate.
- A completed Lexy career baseline is mandatory before confirming the learning
  goals and receiving a personalised plan.
- Existing completed baselines are reused. The foundation does not claim the
  conversational baseline independently verifies role-specific skills.
- Candidates review and confirm their immediate, three-year, and five-year goals.
- Plans contain private next steps. The two customer-service courses are planned
  offerings, not available courses or enrolments in this stage.
- No learning data is added to recruiter or client responses. The existing
  candidate-approved introduction remains a separate sharing surface.

## Rollout

The API resolves access server-side using both of these non-secret settings:

| Setting | Meaning |
| --- | --- |
| `LEARNING_PILOT_ENABLED` | Must be exactly `true`. Anything else disables access. |
| `LEARNING_PILOT_CANDIDATE_IDS` | Comma-separated candidate IDs, or an explicit `*` to allow all candidates. Empty means no access. |

These are operational rollout controls, not candidate-editable preferences.
Development may enable the pilot for preview. Production should remain off until
the migration, privacy checks, and selected cohort are ready. Prefer an explicit
ID allowlist for the first production cohort.

The entry point is `/portal/learning-growth`. Only eligible candidates see the
Learning & Growth navigation item. Disabling the feature stops new access and
writes without deleting saved interests or goals; other portal routes stay
available.

## Data and migration safety

Use `lib/db/drizzle/0059_candidate_learning_profiles.sql`, the additive migration
that creates `candidate_learning_profiles`. Apply it to the intended development database
before enabling this feature. Use the project's documented migration process for
other environments; do not assume publishing automatically migrates an external
production database.

Do not run `drizzle-kit push`: this project's RLS policies and grants are
maintained in SQL. Keep the existing database and security model.

All learning API calls resolve the live candidate identity on the server. A
caller must never be able to select another candidate by supplying an ID.
Tenant-level database isolation is additional protection, not a substitute for
candidate ownership checks.

## Automated checks

After applying the migration to a development test database:

```sh
pnpm --filter @workspace/api-server run test:learning-growth
pnpm --filter @workspace/api-spec run check-codegen
pnpm run typecheck:libs
pnpm --filter @workspace/lexy run typecheck
```

The learning integration test creates and removes its own candidate fixtures.
It exercises the actual tenant middleware and RLS, owner-only access, feature
controls, baseline gating, validation, stale revisions, canonical goal updates,
and course-preview targeting. It does not conduct a new AI baseline interview.

## Goal confirmation and concurrent edits

Confirmation updates the candidate's canonical career goals, and the learning
profile records the confirmed values. A subsequent goal change elsewhere must
require renewed confirmation before displaying a confirmed learning plan.

Mutations use a revision to prevent silent overwrites from two open tabs.
Conflicts should preserve unsaved form values and offer an explicit reload of the
latest saved version.

## Not in this stage

- Course lessons, exercises, enrolments, or completion tracking.
- New role-specific baseline assessment tasks.
- Interview 2 or before-and-after proficiency claims.
- Credits, charges, subscriptions, or payment access.
- Client submissions, intro-video recording, or automatic pipeline changes.
- Employer scores, readiness badges, or hiring priority derived from learning.

The subsequent course stage is documented in
[learning-pilot-courses.md](learning-pilot-courses.md), including its private
practice/progress records and rollout boundaries. The private developmental
reassessment is documented in
[learning-pilot-reassessment.md](learning-pilot-reassessment.md). Course
participation and developmental evidence are not hiring qualifications.