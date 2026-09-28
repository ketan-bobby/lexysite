#!/usr/bin/env bash
#
# setup-db.sh — Set up or repair a Lexy database from the canonical SQL migrations.
#
# WHY THIS EXISTS:
#   This project's security + integrity layer (RLS policies, the app_tenant_in_scope()
#   helper function, GRANTs to the lexy_app role, foreign keys, and CHECK constraints)
#   lives ONLY in the hand-written SQL files under lib/db/drizzle/*.sql.
#
#   `drizzle-kit push` / `push-force` does NOT apply any of that — it only syncs tables,
#   columns, and enums and turns FORCE ROW LEVEL SECURITY on. The result is a database
#   where RLS is forced but no policy exists, so the app role (lexy_app) is denied on
#   every read (returns nothing) and every write (INSERT 500s with
#   "new row violates row-level security policy"). NEVER use push on a real database.
#
#   This script applies every forward migration in order, which produces the correct,
#   complete schema.
#
# USAGE:
#   # Fresh database (recommended for setup or full repair):
#   DATABASE_URL="postgresql://postgres:PASS@localhost:5432/lexy" ./scripts/setup-db.sh
#
#   # Or pass the connection string as the first argument:
#   ./scripts/setup-db.sh "postgresql://postgres:PASS@localhost:5432/lexy"
#
# NOTES:
#   - Run this against a FRESH, empty database for a guaranteed-correct result, then
#     reload your data separately (see REPAIR section at the bottom of this file).
#   - The lexy_app role is cluster-level; it only needs to exist once per PostgreSQL
#     cluster. If it does not exist yet, create it before running (see below).
#   - Requires `psql` on PATH.

set -euo pipefail

# --- Resolve the database connection string ---------------------------------
DB_URL="${1:-${DATABASE_URL:-}}"
if [[ -z "${DB_URL}" ]]; then
  echo "ERROR: no database connection string provided." >&2
  echo "       Set DATABASE_URL or pass it as the first argument." >&2
  echo "       Example: DATABASE_URL=postgresql://postgres:PASS@localhost:5432/lexy $0" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not installed or not on PATH." >&2
  exit 1
fi

# --- Locate the migrations directory ----------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/lib/db/drizzle"

if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
  echo "ERROR: migrations directory not found at ${MIGRATIONS_DIR}" >&2
  exit 1
fi

# --- Ensure the lexy_app role exists (cluster-level, idempotent) -------------
# The migrations GRANT privileges to lexy_app and assume it already exists.
echo ">> Ensuring lexy_app role exists ..."
psql "${DB_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lexy_app') THEN
    CREATE ROLE lexy_app NOLOGIN;
    RAISE NOTICE 'created role lexy_app (NOLOGIN). Set a password / LOGIN as needed for your app connection.';
  END IF;
END
$$;
SQL

# --- Apply every forward migration in order ---------------------------------
# Skip *rollback* files. Sort lexicographically so 0000 .. 0035 run in sequence.
echo ">> Applying migrations from ${MIGRATIONS_DIR} ..."
shopt -s nullglob
applied=0
for f in $(ls "${MIGRATIONS_DIR}"/*.sql | grep -v -- '_rollback' | sort); do
  echo "   -> $(basename "${f}")"
  if ! psql "${DB_URL}" -v ON_ERROR_STOP=1 -f "${f}"; then
    echo "" >&2
    echo "ERROR: migration failed at $(basename "${f}")." >&2
    echo "       Fix the cause and re-run. On a fresh database this should not happen;" >&2
    echo "       on an already-populated database, some statements may conflict." >&2
    exit 1
  fi
  applied=$((applied + 1))
done

echo ""
echo ">> Applied ${applied} migration file(s)."

# --- Verify the security layer is present -----------------------------------
echo ">> Verifying schema health ..."
psql "${DB_URL}" -v ON_ERROR_STOP=1 -t -A <<'SQL'
SELECT 'pg_policies: ' || count(*)::text FROM pg_policies;
SELECT 'app_tenant_in_scope(text): ' ||
       COALESCE(to_regprocedure('app_tenant_in_scope(text)')::text, 'MISSING');
SELECT 'foreign keys: ' || count(*)::text
  FROM pg_constraint WHERE contype = 'f';
SQL

echo ""
echo ">> Done. If 'pg_policies' is 0 or 'app_tenant_in_scope' is MISSING, the database"
echo "   is NOT healthy — do not use it. Re-run on a fresh database."
echo ""
echo "REPAIR (reload data into a freshly-built database):"
echo "   1. pg_dump --data-only --no-owner --disable-triggers \"<OLD_DB_URL>\" > data_only.sql"
echo "   2. createdb lexy_fresh && DATABASE_URL=<lexy_fresh_url> ./scripts/setup-db.sh"
echo "   3. psql \"<lexy_fresh_url>\" -f data_only.sql   # run as a superuser to bypass RLS during load"
echo "   4. Point your app's DATABASE_URL at lexy_fresh and restart."
