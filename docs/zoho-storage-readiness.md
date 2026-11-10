# Zoho storage readiness

Handoff storage added in 0104 is now checked automatically by the required
`zoho-handoff-database-schema` step in `pnpm test:assisted-baseline`. To run just
that read-only audit, use `node scripts/check-zoho-handoff-schema.mjs`.
The command requires exactly 12 boolean checks, rejects malformed or missing
evidence, and returns a failing exit status for any unsafe result. It does not
apply migrations or attest the external production target. See the
[release checklist](zoho-release-checklist.md) for the full deployment boundary.

The existing read-only ATS audit now includes Zoho migrations 0099–0103:

- Account authorization/token custody and reviewed imported jobs.
- Campaign snapshots, recipients, and local human review history.
- Forced RLS, no unexpected policies, no PUBLIC table grants, and no effective
  request-role table or column access.
- Required column types, nullability, defaults, keys, checks, and cascade links.
- Invitation deduplication, including uncertain sends; review history ordering
  and the unique initial-review rule (`NULLS NOT DISTINCT`).
- Exact erasure/identity guards, frozen-plan update/delete protection, and
  append-only review protection.
- Function bodies, signatures, security modes, pinned search paths, effective
  execution grants, and privileged owners where forced-RLS reads require them.
- Dispatch isolation, including the required `live` default.

## Operational check

With the existing authorized database connection configured:

```sh
node scripts/check-recent-db-schema.mjs --ats
```

This command runs catalog queries in a verified read-only transaction and
always rolls back. It reads no stored tokens, applicant records, answers, or
offer content, and does not apply migrations.

A pass reports `scope: ats-schema-metadata-only`. The target remains
`not-independently-attested`: operators must separately confirm which database
the configured connection reaches. A workspace development pass is **not**
production evidence, especially for Lexy's externally hosted production API.
Apply reviewed migrations through the team's existing external release process
before using the corresponding application code.

The combined assisted release gate already calls this audit, so these additional
checks do not require a separate release command.

## Regression evidence

```sh
node --test scripts/check-ats-db-schema.test.mjs \
  scripts/ats-db-schema-sql-fixture.test.mjs
```

The SQL fixture generator is separate from the operational audit. Execution
requires a fingerprint obtained through an explicitly identified development
database handle. It creates only a unique private schema, uses harmless
function stubs, and finishes with rollback and a cleanup assertion.

The fixture exercises intact metadata, deliberate breakages, and actual
request-role SELECT denials after granting schema USAGE. Each negative case
runs in an exception-block subtransaction and is rolled back with a dedicated
sentinel SQLSTATE. Only that sentinel is caught; assertion and SQL errors fail
the run. Intact metadata must pass again after every rollback.

The generated SQL remains below the existing 96 KiB transport budget; repeated
column metadata and cases are compacted without dropping checks.

These fixtures prove catalog detection and privilege boundaries, not live Zoho
acceptance, email delivery, or actual hiring/erasure execution. They do not
replace the separate campaign service tests or the remaining live pilot.
