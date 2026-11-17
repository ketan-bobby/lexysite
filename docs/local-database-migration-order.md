# Local database migration order

Reviewed against repository files on 2026-11-11. This is a dependency reference,
not evidence that a fresh-database rebuild or your local database has been tested.
No database was accessed or changed to prepare this document.

## Important distinction: upgrade versus fresh installation

There is **not currently a single verified empty-database migration chain**.
The numbered chain starts with RLS changes against tables that must already
exist; it does not create the original application schema.

For an existing local database, apply only missing changes after reconciling
its actual schema with the SQL. A highest filename alone does not establish
that every earlier change was applied. Some migrations are not repeatable.

For an empty local database, first obtain a reviewed schema-only baseline and
its exact included-migration inventory. Do not execute `0000` against an empty
database. Neither checked-in root dump is a certified current bootstrap:

- `schema-database.sql`: historical schema-only snapshot (102 public tables).
- `database.sql`: historical schema **and data** snapshot (116 public tables).
  Do not use this as a routine local bootstrap or redistribute its data.

Do not restore both dumps, and do not replay old migrations blindly over a
restored current schema. Restores can already contain policies, tables,
constraints and later function definitions.

## Which files are authoritative?

| Location | Treatment |
| --- | --- |
| `lib/db/drizzle/NNNN_*.sql` without `rollback` | Canonical numbered forward changes, `0000` through `0115` inclusive: 116 files. |
| Dated forward files in `scripts/sql/` listed below | Supplemental changes; these are not all covered by the numbered chain. |
| Any filename containing `rollback` | Do not run during installation or upgrade. Some delete tables/data. |
| `lib/db/prod-apply/rls_up_consolidated.sql` and `scripts/sql/rls_up_consolidated.sql` | Historical consolidated RLS alternative, overlapping numbered migrations. Do not append these to the sequence below. |
| `lib/db/prod-apply/rls_verify.sql`, `scripts/sql/check-*.sql` | Verification, not migrations. Some require bound parameters and their Node checker. |
| `scripts/sql/google-invitation-private-fixture.sql` | Isolated test fixture template, not an application migration. |
| SQL copied into handover/generated output | Distribution copies, not additional migrations. Apply the original source once. |

There is **no implemented `migrate` command in `lib/db/package.json`**.
The migrator/advisory-lock/automatic ledger sections in the older production
runbook describe an intended runner, not an existing one.

## Dependency order for reconciling an existing application baseline

This assumes original application tables/types already exist. Each phase means
**review and apply only missing changes**. It is not permission to replay every
file. The May supplemental files also assume existing original application
tables, such as `pending_trial_signups`, `prep_sessions` and
`candidate_progress_snapshots`.

### 1. Historical May supplemental changes

Reconcile these before proceeding through the numbered upgrades:

```text
scripts/sql/2026-05-13-subscription-plans.sql
scripts/sql/2026-05-13-subscription-extras.sql
scripts/sql/2026-05-13-hire-attribution.sql
scripts/sql/2026-05-14-brochure-parity.sql
scripts/sql/2026-05-14-candidate-engagement.sql
scripts/sql/2026-05-14-current-employee-sourcing.sql
scripts/sql/2026-05-14-market-events.sql
scripts/sql/2026-05-14-trial-extras.sql
```

Many snapshots already include some or all of these. Review existing columns,
types and defaults; `IF NOT EXISTS` does not reconcile incompatible definitions.
In particular, subscription extras supplies the historical `tenants.region`
column that numbered migration `0009` converts to the closed region enum.

### 2. Numbered migrations `0000` through `0076`

Use ascending four-digit order, excluding **every rollback file**:

```text
lib/db/drizzle/0000_rls_pilot.sql
... every numbered forward file in ascending order ...
lib/db/drizzle/0076_usage_economics_labels.sql
```

There are no missing numbers between `0000` and `0115` in the reviewed source.
Do not use a directory wildcard to execute files: it also selects rollbacks.

### 3. October supplemental privacy changes — BEFORE `0077`

Exact order:

```text
scripts/sql/2026-10-11-candidate-account-closure.sql
scripts/sql/2026-10-11-erasure-cleanup-outbox.sql
scripts/sql/2026-10-11-candidate-erasure-write-barrier.sql
```

Why this placement matters:

- The write-barrier file reads `deletion_requests.storage_cleanup`, supplied by
  the cleanup-outbox file.
- It attaches triggers to recruiting workflow tables created by `0069`.
- It creates `public.lexy_erasure_write_barrier()`, used by `0077` and later
  scheduling, ATS and meeting migrations.
- Running numbered migrations all the way through first and applying
  `scripts/sql` afterwards is therefore incorrect.

### 4. Numbered migrations `0077` through `0112`

Continue in ascending order, without skipping intervening files:

```text
0077_interview_offered_times.sql
0078_interview_booking_links.sql
0079_interview_calendar_invitation_attempts.sql
0080_interview_time_change_requests.sql
0081_interview_time_change_withdrawal.sql
0082_interview_calendar_invitation_changes.sql
0083_calendar_panel_consents.sql
0084_interview_schedule_panels.sql
0085_calendar_working_hours.sql
0086_panel_invitation_snapshot.sql
0087_staff_google_calendars.sql
0088_google_interview_invitations.sql
0089_google_panel_consents.sql
0090_interview_zoom_links.sql
0091_ats_verification.sql
0092_ats_imports.sql
0093_ats_import_refresh.sql
0094_ats_refresh_schedules.sql
0095_ats_stage_initial_write_guard.sql
0096_ats_candidate_profiles.sql
0097_ats_profile_erasure_barrier.sql
0098_staff_zoom_meetings.sql
0099_zoho_recruit_accounts.sql
0100_zoho_imported_jobs.sql
0101_zoho_interview_campaigns.sql
0102_zoho_campaign_reviews.sql
0103_zoho_campaign_dispatch_isolation.sql
0104_zoho_stage_handoff_preparation.sql
0105_meeting_notes.sql
0106_meeting_question_review.sql
0107_meeting_notes_shared_erasure_barrier.sql
0108_meeting_speaker_evidence.sql
0109_native_meeting_recording_source.sql
0110_staff_google_meet_recordings.sql
0111_meeting_recording_bounds.sql
0112_meeting_attendance.sql
```

All filenames in this block are under `lib/db/drizzle/`.

### 5. Latest account-security migrations

Apply in this exact order to the database holding the shared `users` table:

```text
lib/db/drizzle/0113_session_revocations.sql
lib/db/drizzle/0114_credential_session_versions.sql
lib/db/drizzle/0115_explicit_all_session_revocation.sql
```

If the local application uses one database, these follow `0112` in that database.
If identity/control and regional application databases are separate, do not
blindly send all three to every regional database; confirm connection routing.

`0113` and `0114` are not idempotent. `0115` replaces the function created by
`0114`; replaying `0114` later is not a safe retry strategy.

Stop API processes, workers and schedulers before migrating. After the reviewed
changes succeed, start every API instance on the same compatible source version.
Do not allow mixed old/new API versions to issue sessions or change passwords.

## Listing the exact numbered files without running them

From the repository root, this Python command only **prints** the list:

```bash
python3 - <<'PY'
from pathlib import Path
for p in sorted(Path("lib/db/drizzle").glob("[0-9][0-9][0-9][0-9]_*.sql")):
    if "rollback" not in p.name:
        print(p)
PY
```

Remember to insert phase 3 between `0076` and `0077`; the printed list cannot
show these supplemental dependencies.

## Applying one reviewed, unapplied file locally

Use PostgreSQL 16-compatible tools, an owner/migration account with permission
to create roles/functions/policies, and a backed-up local database. Some dump
files also contain psql meta-commands that require a sufficiently recent psql.

Set `LOCAL_DATABASE_URL` privately on your computer. Do not paste its value into
chat or commit it. Confirm the target before any write:

```bash
psql "$LOCAL_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SELECT current_database(), current_user, inet_server_addr(), inet_server_port();'
```

For example, **only if `0113` is confirmed missing and its prerequisites exist**:

```bash
psql "$LOCAL_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f lib/db/drizzle/0113_session_revocations.sql
```

Run one reviewed file at a time, preserve output and record successful files.
Stop at the first error. Do not strip failing statements, suppress errors,
drop existing objects, or grant broader access to make an upgrade pass.
Some files have explicit transactions and some do not; do not assume a failed
file was entirely rolled back. Inspect its effects before retrying.
Do not concatenate the whole chain into one transaction: enum additions and
files with their own transaction boundaries require individual review.

Do not run `drizzle-kit push`, `push --force`, or schema-reset commands as an
upgrade shortcut: they can remove SQL-managed RLS, triggers and constraints.

## What is needed for an exact resume point?

Provide these non-secret details:

1. Was the local database empty, restored from a dump, or previously working?
2. Which dump/source revision was used, if known?
3. The first failing SQL filename and complete PostgreSQL error.
4. The last file known to have completed successfully.

Until the local baseline is established, this document gives the dependency
order but cannot honestly certify that executing all files will succeed.
