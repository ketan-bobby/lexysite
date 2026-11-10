# Recent database schema readiness

### Saved-panel invitations (development only)

Migration `0086_panel_invitation_snapshot.sql` adds nullable private JSON
snapshot evidence to the existing invitation ledger. Apply it through the
approved migration process on the verified API database target before deploying
the updated API there. Existing invitation reads also select the new column.
The development target has been migrated; production
has not been changed. Existing rows remain candidate-only attempts; do not
backfill approval evidence or remove an uncertain attempt to enable another send.

The metadata contract includes this column and the existing ledger RLS, grants
and erasure barrier. It also uses PostgreSQL's catalog type `int4`, not the SQL
alias `integer`, when checking saved-panel buffer storage.

The development read-only metadata check passed 187/187 checks on 2026-10-24.
This is not production metadata evidence or proof of real Outlook delivery.

### Controlled calendar invitations (development only)

The reviewed additive `0079_interview_calendar_invitation_attempts.sql` was
applied to the explicitly fingerprint-verified development database on
2026-10-22. No production DDL was performed. Its private intent table, erasure
barrier, request-role denial, columns and constraints are included in the
readiness contract. Missing or weakened storage fails invitation actions
closed before Graph writes; it does not disable native booking or email.

Release verification must check the same metadata on the actual production
database target before enabling staff use. Do not assume that an external
production database is migrated merely because the app is published.

This is a read-only metadata check for the recent provider-usage, complimentary
Enterprise pilot, candidate-account erasure, cleanup, and candidate-specific
offered interview times and booking links.

## Candidate booking links

Apply the reviewed additive migration `lib/db/drizzle/0078_interview_booking_links.sql`
to the **verified API database target** before enabling links there. This
workspace's development database has been migrated and checked; that is not
evidence of a production rollout. Publishing the app does not itself migrate
an external production database.

The migration adds a server-private, forced-RLS token-hash table and erasure
barrier plus three invalidation triggers: changes to schedules, application
ownership and published alternatives revoke unconsumed links. The public API
refuses to mint or read links if any required trigger, forced RLS, table privacy
or erasure barrier is missing. The token is a bearer capability, **not identity
verification**. Only the issuing response contains the raw token; replacing
or revoking the link invalidates earlier tokens. The link never exposes staff
calendars or private evaluation data. Confirming records a native time only:
it neither reserves an external slot nor emails an invitation.

After an approved production migration, run the read-only schema check below
against the **actual production API database** (not development), review the
target and result with the team, then test with an authorized synthetic
schedule. A 503 means a partial/missing rollout, not an empty set of offered
times. A consumed link returns its exact native confirmation receipt, so do
not resend an invitation to repair a lost response.

## Offered-time rollout checks

The same read-only command now includes the offered-time table's seven required
columns, primary key, schedule foreign key with deletion cascade, forced row-level
security, absence of request-role policies, and correctly bound erasure-write
barrier. It also rejects effective `lexy_app` table or column privileges,
including grants inherited through PUBLIC or another role. Checking table ACLs
alone is insufficient: a column-level grant can remain after table grants are
removed. An absent request role is not accepted as evidence of restricted access.

Verified through the explicitly selected **development** database handle on
2026-10-22: **132/132 metadata checks passed**. The expanded rollback-only
fixture passed **33 negative scenarios**, including disabled/unforced offered-time
RLS, accidental policies, table and column grants, public column grants, loss of
the schedule deletion cascade and loss of the erasure barrier. The intact
fixture passed before and after those cases, and final cleanup was confirmed.
Thirteen checker/generator unit tests passed. No application records or shared
schema objects were changed by these checks.

This is development evidence only. The production operator must run the
read-only command against the actual production target before enabling the
feature there. A pass is not a calendar-provider acceptance test, a migration
execution receipt, or proof that all unrelated production gaps are closed.

## Run

From the source checkout with dependencies installed:

```sh
node scripts/check-recent-db-schema.mjs
```

It uses the existing `DATABASE_URL` exactly as the API does. It does not print
the URL, host, credentials, function bodies, or candidate records. Do not paste
connection strings into chat or change shared development credentials just to
check production.

To verify production, an authorized operator must run it in an approved context
connected to the actual production API database. Running it in this workspace
verifies only this workspace's configured database. The report intentionally
does not attest which environment a connection belongs to.

## Meaning of results

- Exit **0**: every expected metadata check passed on that connection.
- Exit **1**: one or more expected objects are absent or differ from the contract.
  The JSON identifies the checks that need review.
- Exit **2**: connection, transaction, contract, or query execution failed. This
  is not a pass. Connection details are intentionally omitted from errors.

The check opens a repeatable-read, read-only transaction, confirms the read-only
setting, reads PostgreSQL catalogs, and rolls back. It never applies migrations,
calls the erasure functions, inserts fixtures, or touches candidate rows.

Checks include:

- Required tables, column types, nullability, and insert-critical defaults.
- Required primary/unique/foreign-key constraints, bounded usage labels and
  unknown-cost semantics.
- Valid index definitions, including active pilot grant uniqueness.
- RLS and restricted control-plane policy expectations.
- Erasure functions' signatures, bodies, security-definer configuration and
  fixed search paths.
- Enabled row-level before-insert/update erasure triggers and their arguments,
  including dynamically discovered candidate-linked tables.

This is not a full database security audit, behavioral erasure proof, backup
test, or verification of actual AWS file deletion. A pass does not enable or
disable any product functionality.

## Migration sources and timestamp discrepancy

Relevant files are migrations `0072` through `0075` in `lib/db/drizzle/`, plus
the three candidate-erasure SQL files dated `2026-10-11` in `scripts/sql/`.
Do not run them automatically or use a broad schema push: preserve existing RLS,
grants, triggers, and the project's approved migration process.

The historical `0073` SQL declares pilot date fields without time zones, while
`lib/db/src/schema/pilot-codes.ts` expects timezone-aware timestamps. The current
workspace database has the runtime-compatible timezone-aware types. This check
requires those runtime types; a database created only from the older SQL will
be flagged for review. No historical migration or live column was rewritten.
An approved correction must establish the intended interpretation of existing
dates before any conversion, rather than assuming a timezone.

## Test the checker

```sh
node --import ./scripts/test-egress-guard.mjs --test scripts/check-recent-db-schema.test.mjs scripts/recent-db-schema-sql-fixture.test.mjs
```

These unit checks are also included in the assisted baseline's lightweight
planner/progress group. They do not connect to a database.

## Workspace verification, 2026-10-14

The configured workspace database passed all 121 metadata checks. This is not
production attestation and does not claim every historical migration was applied
through a particular migration runner. It establishes the inspected objects'
current shape on that connection.

## SQL-level failure tests

`scripts/recent-db-schema-sql-fixture.mjs` generates development-only test SQL.
It does not open a database connection or execute its output. The test SQL uses
the same catalog query as the operational checker, with a bound private schema.
The operational checker itself always binds `public`; it has no schema CLI
override.

Use the exported `developmentFingerprintSql` through the explicitly selected
**development** database handle. Pass that returned non-secret fingerprint to:

```sh
node scripts/recent-db-schema-sql-fixture.mjs DEVELOPMENT_FINGERPRINT
```

Execute its output only through the approved development SQL runner. Do not use
an unconfirmed application connection or run this as a production migration.
The fingerprint guard rejects a different database/server instance before
creating objects; regenerating the fingerprint is necessary after an instance
restart.

All DDL targets a unique, private fixture schema. Erasure functions are replaced
with harmless stubs; application erasure code is never installed or invoked by
the fixture. No candidate rows are read or inserted. Savepoints restore each
deliberately broken condition, and the final rollback removes the entire
fixture. A final catalog query confirms cleanup. There is no commit.

Verified on 2026-10-14 using the development database handle:

- **25 negative scenarios** were detected with exactly the expected failures:
  missing/mistyped columns and defaults, stale constraints, lost uniqueness,
  missing indexes, weakened RLS/policies/grants, disabled/conditional/misbound
  triggers, and drifted or missing security-definer functions.
- The intact fixture passed before and after the negative scenarios.
- Fixture cleanup passed.
- A deliberately wrong target fingerprint was rejected before fixture creation.
- The operational read-only checker still passed all **121 workspace checks**.

Fixture-generator safety tests are included in the assisted baseline's
lightweight group. The actual SQL-level run above is separate; passing the
generator unit tests alone does not constitute a new SQL-level verification.
