# Runbook: Production Database Migrations

**Owner:** Platform on-call · **Last reviewed:** 2026-05-17 · **Audience:** any
engineer paged for a Lexy migration.

This runbook covers the *only* supported way to push schema changes to the
Lexy production database. Drizzle migrations are **forward-only**. There is
no `drizzle-kit down`. Roll forward, never back.

---

## 1. Golden rules

1. **Forward-only.** Every committed migration must be applied to production
   exactly once, in order. Never edit a migration that has shipped — write a
   new one that fixes the previous one.
2. **Idempotent or `IF NOT EXISTS`.** Every `CREATE`/`ALTER` should be safe
   to re-run. Use `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
   `DROP ... IF EXISTS`. Drizzle's generated SQL does not always do this —
   audit each migration by eye before merging.
3. **Two-phase for destructive changes.** Drops, renames, and type changes
   ship in two PRs: (a) make the new shape live behind a feature flag,
   backfill, deploy; (b) remove the old shape once code no longer references
   it.
4. **Never `TRUNCATE` or `DELETE FROM` in a migration.** Data migrations go
   through a one-off script reviewed separately. Migrations alter shape, not
   payload.
5. **Append-only governance tables stay append-only.** `decision_events`,
   `candidate_disclosure_acks`, `admin_impersonation_sessions`,
   `stripe_processed_events` — never update or delete rows.

## 2. Authoring a migration

> **Reality check (updated 2026-07-09).** Migrations in this repo are
> **hand-written SQL**, not generated. There is no `drizzle:generate`
> script, no `lib/db/drizzle/meta/` journal, and `drizzle-kit generate`
> will NOT work with the current config (it would emit a colliding
> full-schema `0000` snapshot). Do not attempt to wire it up ad hoc.
>
> **Never use `drizzle-kit push`.** It creates tables from the TS schema
> but silently strips everything that exists only in the hand-written
> SQL: RLS policies, grants, FKs, CHECK constraints, and helper
> functions like `app_tenant_in_scope`. The result is a deny-all or
> wide-open database. The package scripts have been renamed to
> `push-DANGEROUS-strips-rls` / `push-force-DANGEROUS-strips-rls` so
> they cannot be run by muscle memory.

The actual process:

1. All migrations live in **`lib/db/drizzle/`** as a pair of files:
   `NNNN_<kebab_name>.sql` (forward) and `NNNN_<kebab_name>_rollback.sql`
   (documentation-only — we never run rollbacks, see §6).
2. **Numbering:** `NNNN` is a zero-padded 4-digit sequence. Find the
   current highest prefix (`ls lib/db/drizzle | sort | tail`) and use the
   next number. As of this writing the highest is `0052_demo_requests`,
   so the **next migration is `0053`**. Never reuse or renumber.
3. Write the forward SQL by hand, following the golden rules in §1.
4. Make the matching TypeScript schema change in `lib/db/src/schema/`
   in the same PR (the TS schema and the SQL are maintained in parallel
   — neither generates the other).

### Hand-maintained objects the TS schema does NOT track

The Drizzle TypeScript schema is **not** the full source of truth. The
following exist **only** in the hand-written SQL, and no tool will warn
you if a migration drops or fails to preserve them — you must verify by
eye every time you touch the affected tables:

- **`candidates_user_id_unique`** (see `0012_candidates_user_id_fk.sql`)
  and other hand-added unique/partial indexes.
- **Tenant FK constraints** (e.g. from `0002_tenant_id_fks.sql`) linking
  tenant-scoped tables back to `tenants`.
- **All RLS policies, `FORCE ROW LEVEL SECURITY` flags, grants, and the
  `app_tenant_in_scope` helper** (see `0000_rls_pilot.sql`,
  `0001_rls_extension.sql`, `0004_rls_carveouts_bespoke.sql`, and
  `lib/db/prod-apply/rls_up_consolidated.sql`).

If your migration recreates or replaces a table, you are responsible for
re-applying every one of these by hand in the same migration.

Review checklist for the SQL:

- Confirm every `CREATE TABLE` uses `IF NOT EXISTS`.
- Confirm every `ADD COLUMN` uses `IF NOT EXISTS`.
- Confirm every `CREATE INDEX` uses `IF NOT EXISTS` (preferably
  `CREATE INDEX CONCURRENTLY` for big tables).
- For columns with a `NOT NULL` constraint on a non-empty table: add the
  column nullable, backfill, then `SET NOT NULL` in a follow-up migration.
- For `ALTER COLUMN ... TYPE`: only safe types (e.g. `text → varchar(N)`
  when N covers the max length already present). Otherwise two-phase.
- Add `--rollback` comments at the bottom describing the forward-fix
  procedure (we do not run them, but auditors want them).

Run the rollup that rebuilds the bundled `lib/db/dist`:

```bash
pnpm --filter @workspace/db run build
```

Then run the API server `tsc` to ensure schemas + queries still compile:

```bash
pnpm --filter @workspace/api-server run typecheck
```

## 3. PR review checklist

Reviewer must verify, before approving:

- [ ] Migration filename matches the next available `NNNN` prefix and uses
      kebab_case.
- [ ] No edits to any previously-shipped migration file.
- [ ] All DDL uses `IF NOT EXISTS` / `IF EXISTS` where applicable.
- [ ] No `TRUNCATE`, no unconditional `DELETE`, no `UPDATE` of immutable
      governance tables.
- [ ] If the migration adds a column with a default and `NOT NULL`, the
      table is small (<10k rows) — otherwise rejected and split.
- [ ] Drizzle schema TypeScript change is in the same PR; `schema/index.ts`
      re-exports it.
- [ ] `lib/db/dist` rebuilt and committed.
- [ ] API server build succeeds locally (`pnpm --filter
      @workspace/api-server run build`).
- [ ] Author has updated this runbook if the process itself changed.

## 4. Applying to production

We apply migrations from a one-off, *non-scheduler* worker. The production
API servers do **not** auto-migrate on boot — this is intentional so that a
fast rolling deploy never races with DDL.

> **Note (2026-07-09):** there is currently **no `migrate` script** in
> `lib/db/package.json` — the command below is aspirational. Until one
> is wired up, apply each unapplied `lib/db/drizzle/NNNN_*.sql` file by
> hand, in order, via `psql "$DATABASE_URL" -1 -f <file>` (one
> transaction per file), and record what you applied in the PR.

```bash
# from the migration jumpbox (or `replit deployment ... shell`)
export DATABASE_URL=postgres://...     # production read-write URL
pnpm --filter @workspace/db run migrate
```

The migrator:

1. Acquires an advisory lock `pg_advisory_lock(8675309)` so only one worker
   can apply migrations at a time.
2. Reads `__drizzle_migrations` to find unapplied files.
3. Applies each file inside a transaction (one per file). On failure the
   file's transaction rolls back; previously-applied files remain.
4. Releases the lock on exit (success or failure).

A successful run prints `Applied N migrations` and exits 0. Tee the output
into an incident-tracked log:

```bash
pnpm --filter @workspace/db run migrate 2>&1 | tee /tmp/migrate-$(date +%s).log
```

## 5. Verification after apply

```sql
SELECT id, hash, created_at
FROM __drizzle_migrations
ORDER BY created_at DESC
LIMIT 5;
```

The top row should match the migration you just shipped. Then sanity-check
the table you altered:

```sql
\d+ <table_name>
```

Confirm the new column / index is present.

## 6. If something goes wrong

We do **not** run a `down` migration. Failure modes and their forward-fix:

| Failure                                                | Forward fix                                                                                       |
|--------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| Migration applied partially (rare — we use per-file tx) | Inspect `__drizzle_migrations`; write a new migration that finishes the work idempotently.        |
| Column added with wrong type                            | New migration that adds a second column with the right type, backfills, then drops the old one.   |
| Index too slow / locked the table                       | `DROP INDEX CONCURRENTLY <name>`; new migration with `CREATE INDEX CONCURRENTLY`.                 |
| Constraint added that conflicts with existing rows      | New migration that drops the constraint, plus a one-off data-cleanup script, then re-adds it.     |
| App started referencing a column not yet migrated       | Revert the *application* deploy. Migrations stay forward.                                          |

If you find yourself wanting to `DROP TABLE` or `DROP COLUMN` data that is
governance-relevant (decision events, disclosure acks, impersonation,
Stripe ledger): **stop**. File a ticket, get legal sign-off, then ship a
new append-only audit row recording the deletion before doing it.

## 7. Applying governance migrations (0016, 0017, …)

These migrations are the audit backbone (`decision_events`,
`candidate_disclosure_acks`, `appeals_requests`, `stripe_processed_events`,
`admin_impersonation_sessions`). They are all append-only.

Order of operations for a clean rollout:

1. Apply the migration (above procedure).
2. Verify `__drizzle_migrations` row exists.
3. Deploy the application image that *writes* to the new table.
4. Watch the relevant table fill (`SELECT count(*) FROM <table>` every
   minute for 10 minutes) to confirm production traffic is exercising the
   write path.
5. Update the Grafana dashboard (or equivalent) panel for the new table.

If step 4 shows zero writes when traffic clearly should be exercising the
path, page the on-call: it almost certainly means the application is
silently failing the write (most common cause: `onConflictDoNothing`
silently swallowing a constraint mismatch).

## 8. Database-level safety nets

These are configured outside this repo but documented here for
on-call reference:

- **Backups.** Continuous WAL archival to S3; daily logical dumps retained
  30 days. Restore tested quarterly.
- **PITR window.** 7 days. If a destructive change ships, you have 7 days
  to PITR — but only as a last resort, since it loses all writes since the
  restore point.
- **Read replica.** One synchronous replica for failover, one async for
  analytics. Migrations apply against the primary only.
- **Connection limits.** Per-tenant pooling via PgBouncer; do not run
  long migrations during business hours without raising `statement_timeout`
  for the session.

## 9. Off-hours window

Default policy: apply migrations Mon–Thu, 09:00–11:00 Pacific. This gives
us a full business day to catch follow-on issues before a weekend. Hot
fixes (security, GDPR/CCPA deletion correctness, billing correctness) may
be applied any time with VP Engineering approval.

## 10. Audit log

Every production migration application appends a row to the
`__drizzle_migrations` table (Drizzle does this automatically). For
SOC2 Type 1 readiness we also expect the on-call engineer to paste the
migrator output into the migration's PR as a closing comment.
