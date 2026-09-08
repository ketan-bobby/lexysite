#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# setup-db.sh -- Set up or repair a Lexy database from the canonical SQL
#                migrations. Ubuntu/Linux version of scripts/setup-db.bat.
#
# This script applies every forward migration in order, which produces the
# correct, complete schema. NEVER use drizzle-kit push on a real database.
#
# USAGE (run from the repo root):
#   export DATABASE_URL='postgresql://postgres:PASS@localhost:5432/lexy'
#   scripts/setup-db.sh
#
# Or pass the connection string as the first argument:
#   scripts/setup-db.sh 'postgresql://postgres:PASS@localhost:5432/lexy'
#
# Requires `psql` on PATH (installed with PostgreSQL).
# ============================================================================

# --- Resolve the database connection string ---------------------------------
DB_URL="${1:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
    echo "ERROR: no database connection string provided." >&2
    echo "       Set DATABASE_URL or pass it as the first argument." >&2
    echo "       Example: DATABASE_URL='postgresql://postgres:PASS@localhost:5432/lexy' scripts/setup-db.sh" >&2
    exit 1
fi

# --- Check psql is available -------------------------------------------------
if ! command -v psql >/dev/null 2>&1; then
    echo "ERROR: psql is not installed or not on PATH." >&2
    echo "       Install PostgreSQL client tools, for example:" >&2
    echo "       sudo apt update && sudo apt install -y postgresql-client" >&2
    exit 1
fi

# --- Locate the migrations directory ----------------------------------------
# SCRIPT_DIR is the directory containing this script.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/lib/db/drizzle"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
    echo "ERROR: migrations directory not found at $MIGRATIONS_DIR" >&2
    exit 1
fi

# --- Ensure the lexy_app role exists (cluster-level, idempotent) -------------
echo ">> Ensuring lexy_app role exists ..."
psql -d "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lexy_app') THEN
        CREATE ROLE lexy_app NOLOGIN;
        RAISE NOTICE 'created role lexy_app (NOLOGIN). Set a password / LOGIN as needed for your app connection.';
    END IF;
END
$$;
SQL

# --- Optional resume mode for already-partially-migrated databases ----------
# Set SKIP_0000=1 when 0000_rls_pilot.sql has already been applied.
# Also auto-detect the baseline if the tenant-isolation policies already exist.
SKIP_0000="${SKIP_0000:-0}"

if [[ "$SKIP_0000" == "1" ]]; then
    echo ">> Baseline 0000_rls_pilot.sql already present; skipping it."
else
    if result="$(
        psql -d "$DB_URL" -v ON_ERROR_STOP=1 -t -A -q -c \
        "SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename IN ('candidates', 'applications', 'interview_sessions')
              AND policyname = 'tenant_isolation'
        ) THEN 1 ELSE 0 END;"
    )"; then
        # Trim whitespace/newlines from psql output.
        result="$(printf '%s' "$result" | tr -d '[:space:]')"
        if [[ "$result" == "1" ]]; then
            SKIP_0000=1
            echo ">> Baseline 0000_rls_pilot.sql already present; skipping it."
        fi
    else
        echo "ERROR: failed while checking whether the baseline migration is already applied." >&2
        exit 1
    fi
fi

# --- Apply every forward migration in order ---------------------------------
# Skip *_rollback* files. sort -V gives natural numeric ordering:
# 0000, 0001, ... 0035.
echo ">> Applying migrations from $MIGRATIONS_DIR ..."

applied=0

while IFS= read -r migration_path; do
    MIG_FILE="$(basename -- "$migration_path")"

    # Skip rollback migrations.
    if [[ "$MIG_FILE" == *"_rollback"* ]]; then
        continue
    fi

    if [[ "$SKIP_0000" == "1" && "$MIG_FILE" == "0000_rls_pilot.sql" ]]; then
        echo "   -> $MIG_FILE (already applied)"
        continue
    fi

    echo "   -> $MIG_FILE"

    if ! psql -d "$DB_URL" -v ON_ERROR_STOP=1 -f "$migration_path"; then
        if [[ "$MIG_FILE" == "0002_tenant_id_fks.sql" ]]; then
            platform_tenant_exists="$(psql -d "$DB_URL" -v ON_ERROR_STOP=1 -t -A -q -c "SELECT EXISTS (SELECT 1 FROM tenants WHERE id = 'platform');")"
            legacy_platform_rows="$(psql -d "$DB_URL" -v ON_ERROR_STOP=1 -t -A -q -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM candidates WHERE tenant_id = 'platform') OR EXISTS (SELECT 1 FROM applications WHERE tenant_id = 'platform') OR EXISTS (SELECT 1 FROM interview_sessions WHERE tenant_id = 'platform') OR EXISTS (SELECT 1 FROM jobs WHERE tenant_id = 'platform') THEN 1 ELSE 0 END;")"

            if [[ "${platform_tenant_exists}" != "t" && "${legacy_platform_rows}" == "1" ]]; then
                echo "   -> repairing missing platform tenant row for legacy platform-pool data..."
                psql -d "$DB_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO tenants (id, name, slug, status, plan, created_at, updated_at) VALUES ('platform', 'Platform', 'platform', 'active', 'enterprise', now(), now()) ON CONFLICT (id) DO NOTHING;"
                if ! psql -d "$DB_URL" -v ON_ERROR_STOP=1 -f "$migration_path"; then
                    echo >&2
                    echo "ERROR: migration failed at $MIG_FILE after repairing legacy platform tenant data." >&2
                    exit 1
                fi
            else
                echo >&2
                echo "ERROR: migration failed at $MIG_FILE." >&2
                echo "       Fix the cause and re-run. On a fresh database this should not happen;" >&2
                echo "       on an already-populated database, some statements may conflict." >&2
                exit 1
            fi
        else
            echo >&2
            echo "ERROR: migration failed at $MIG_FILE." >&2
            echo "       Fix the cause and re-run. On a fresh database this should not happen;" >&2
            echo "       on an already-populated database, some statements may conflict." >&2
            exit 1
        fi
    fi

    applied=$((applied + 1))
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print0 | \
    while IFS= read -r -d '' f; do
        printf '%s\n' "$f"
    done | sort -V)

echo
echo ">> Applied $applied migration file(s)."

# --- Verify the security layer is present -----------------------------------
echo ">> Verifying schema health ..."

psql -d "$DB_URL" -v ON_ERROR_STOP=1 -t -A \
    -c "SELECT 'pg_policies: ' || count(*)::text FROM pg_policies;" \
    -c "SELECT 'app_tenant_in_scope(text): ' || COALESCE(to_regprocedure('app_tenant_in_scope(text)')::text, 'MISSING');" \
    -c "SELECT 'foreign keys: ' || count(*)::text FROM pg_constraint WHERE contype = 'f';"

echo
echo ">> Done. If 'pg_policies' is 0 or 'app_tenant_in_scope' is MISSING, the database"
echo "   is NOT healthy -- do not use it. Re-run on a fresh database."
echo
echo "REPAIR (reload data into a freshly-built database):"
echo '   1. pg_dump --data-only --no-owner --disable-triggers "<OLD_DB_URL>" > data_only.sql'
echo '   2. createdb lexy_fresh  (then run this script against lexy_fresh)'
echo '   3. psql "<lexy_fresh_url>" -f data_only.sql   (run as a superuser to bypass RLS during load)'
echo "   4. Point your app's DATABASE_URL at lexy_fresh and restart."
