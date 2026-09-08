#!/usr/bin/env bash
#
# setup-db.sh — Set up or repair a Lexy database from the canonical SQL
#                 migrations. Bash version of scripts/setup-db.bat.
#
# WHY THIS EXISTS:
#   This project's security + integrity layer (RLS policies, the
#   app_tenant_in_scope() helper function, GRANTs to the lexy_app role, foreign
#   keys, and CHECK constraints) lives ONLY in the hand-written SQL files under
#   lib/db/drizzle/*.sql.
#
#   `drizzle-kit push` / `push-force` does NOT apply any of that -- it only syncs
#   tables, columns, and enums and turns FORCE ROW LEVEL SECURITY on. The result
#   is a database where RLS is forced but no policy exists, so the app role
#   (lexy_app) is denied on every read (returns nothing) and every write
#   (INSERT 500s with "new row violates row-level security policy").
#   NEVER use push on a real database.
#
#   This script applies every forward migration in order, which produces the
#   correct, complete schema.
#
# USAGE (run from the repo root):
#   DATABASE_URL="postgresql://postgres:PASS@localhost:5432/lexy" ./scripts/setup-db.sh
#
#   or pass the connection string as the first argument:
#   ./scripts/setup-db.sh "postgresql://postgres:PASS@localhost:5432/lexy"
#
# NOTES:
#   - Run against a FRESH, empty database for a guaranteed-correct result, then
#     reload your data separately (see REPAIR section at the bottom).
#   - The lexy_app role is cluster-level; it only needs to exist once per cluster.
#   - Requires `psql` on PATH (installed with PostgreSQL).

set -euo pipefail

# --- Resolve the database connection string ---------------------------------
DB_URL="${1:-${DATABASE_URL:-}}"
if [[ -z "${DB_URL}" ]]; then
  echo "ERROR: no database connection string provided." >&2
  echo "       Set DATABASE_URL or pass it as the first argument." >&2
  echo "       Example: DATABASE_URL=postgresql://postgres:PASS@localhost:5432/lexy ./scripts/setup-db.sh" >&2
  exit 1
fi

# --- Check psql is available -------------------------------------------------
if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not installed or not on PATH." >&2
  echo "       Install PostgreSQL and add its bin directory to PATH." >&2
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
echo ">> Ensuring lexy_app role exists ..."
psql "${DB_URL}" -v ON_ERROR_STOP=1 -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lexy_app') THEN CREATE ROLE lexy_app NOLOGIN; RAISE NOTICE 'created role lexy_app (NOLOGIN). Set a password / LOGIN as needed for your app connection.'; END IF; END \$\$;"

# --- Optional resume mode for already-partially-migrated databases -----------
# Set SKIP_0000=1 when 0000_rls_pilot.sql has already been applied.
SKIP_0000="${SKIP_0000:-0}"
if [[ "${SKIP_0000}" == "1" ]]; then
  echo ">> Baseline 0000_rls_pilot.sql already present; skipping it."
fi

# --- Apply every forward migration in order ---------------------------------
# Skip *_rollback* files. Bash glob order is lexicographic enough for 0000 .. 0035.
echo ">> Applying migrations from ${MIGRATIONS_DIR} ..."
shopt -s nullglob
files=("${MIGRATIONS_DIR}"/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "ERROR: no SQL migration files found in ${MIGRATIONS_DIR}" >&2
  exit 1
fi

applied=0
for f in "${files[@]}"; do
  filename="$(basename "${f}")"

  if [[ "${SKIP_0000}" == "1" && "${filename}" == "0000_rls_pilot.sql" ]]; then
    echo "   -> ${filename} (already applied)"
    continue
  fi

  case "${filename}" in
    *_rollback*)
      continue
      ;;
  esac

  echo "   -> ${filename}"
  if ! psql "${DB_URL}" -v ON_ERROR_STOP=1 -f "${f}"; then
    echo "" >&2
    echo "ERROR: migration failed at ${filename}." >&2
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
echo "   is NOT healthy -- do not use it. Re-run on a fresh database."
echo ""
echo "REPAIR (reload data into a freshly-built database):"
echo "   1. pg_dump --data-only --no-owner --disable-triggers \"<OLD_DB_URL>\" > data_only.sql"
echo "   2. createdb lexy_fresh && DATABASE_URL=<lexy_fresh_url> ./scripts/setup-db.sh"
echo "   3. psql \"<lexy_fresh_url>\" -f data_only.sql   # run as a superuser to bypass RLS during load"
echo "   4. Point your app's DATABASE_URL at lexy_fresh and restart."
