@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM setup-db.bat -- Set up or repair a Lexy database from the canonical SQL
REM                 migrations. Windows version of scripts/setup-db.sh.
REM
REM WHY THIS EXISTS:
REM   This project's security + integrity layer (RLS policies, the
REM   app_tenant_in_scope() helper function, GRANTs to the lexy_app role, foreign
REM   keys, and CHECK constraints) lives ONLY in the hand-written SQL files under
REM   lib\db\drizzle\*.sql.
REM
REM   `drizzle-kit push` / `push-force` does NOT apply any of that -- it only syncs
REM   tables, columns, and enums and turns FORCE ROW LEVEL SECURITY on. The result
REM   is a database where RLS is forced but no policy exists, so the app role
REM   (lexy_app) is denied on every read (returns nothing) and every write
REM   (INSERT 500s with "new row violates row-level security policy").
REM   NEVER use push on a real database.
REM
REM   This script applies every forward migration in order, which produces the
REM   correct, complete schema.
REM
REM USAGE (run from the repo root, in Command Prompt):
REM   set DATABASE_URL=postgresql://postgres:PASS@localhost:5432/lexy
REM   scripts\setup-db.bat
REM
REM   or pass the connection string as the first argument:
REM   scripts\setup-db.bat "postgresql://postgres:PASS@localhost:5432/lexy"
REM
REM NOTES:
REM   - Run against a FRESH, empty database for a guaranteed-correct result, then
REM     reload your data separately (see REPAIR section at the bottom).
REM   - The lexy_app role is cluster-level; it only needs to exist once per cluster.
REM   - Requires `psql` on PATH (installed with PostgreSQL).
REM ============================================================================

REM --- Resolve the database connection string --------------------------------
set "DB_URL=%~1"
if "%DB_URL%"=="" set "DB_URL=%DATABASE_URL%"
if "%DB_URL%"=="" (
  echo ERROR: no database connection string provided.>&2
  echo        Set DATABASE_URL or pass it as the first argument.>&2
  echo        Example: set DATABASE_URL=postgresql://postgres:PASS@localhost:5432/lexy ^&^& scripts\setup-db.bat>&2
  exit /b 1
)

REM --- Check psql is available -----------------------------------------------
where psql >nul 2>nul
if errorlevel 1 (
  echo ERROR: psql is not installed or not on PATH.>&2
  echo        Install PostgreSQL and add its bin directory to PATH.>&2
  exit /b 1
)

REM --- Locate the migrations directory ---------------------------------------
REM %~dp0 = directory of this script (with trailing backslash). Repo root is one up.
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
set "MIGRATIONS_DIR=%REPO_ROOT%\lib\db\drizzle"

if not exist "%MIGRATIONS_DIR%" (
  echo ERROR: migrations directory not found at %MIGRATIONS_DIR%>&2
  exit /b 1
)

REM --- Ensure the lexy_app role exists (cluster-level, idempotent) -----------
echo ^>^> Ensuring lexy_app role exists ...
psql "%DB_URL%" -v ON_ERROR_STOP=1 -q -c "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lexy_app') THEN CREATE ROLE lexy_app NOLOGIN; RAISE NOTICE 'created role lexy_app (NOLOGIN). Set a password / LOGIN as needed for your app connection.'; END IF; END $$;"
if errorlevel 1 (
  echo ERROR: failed to ensure lexy_app role.>&2
  exit /b 1
)

REM --- Apply every forward migration in order --------------------------------
REM Skip *_rollback* files. `dir /b /o:n` sorts by name so 0000 .. 0035 run in order.
echo ^>^> Applying migrations from %MIGRATIONS_DIR% ...
set /a applied=0
for /f "delims=" %%f in ('dir /b /o:n "%MIGRATIONS_DIR%\*.sql" ^| findstr /v /i "_rollback"') do (
  echo    -^> %%f
  psql "%DB_URL%" -v ON_ERROR_STOP=1 -f "%MIGRATIONS_DIR%\%%f"
  if errorlevel 1 (
    echo.>&2
    echo ERROR: migration failed at %%f.>&2
    echo        Fix the cause and re-run. On a fresh database this should not happen;>&2
    echo        on an already-populated database, some statements may conflict.>&2
    exit /b 1
  )
  set /a applied+=1
)

echo.
echo ^>^> Applied !applied! migration file(s).

REM --- Verify the security layer is present ----------------------------------
echo ^>^> Verifying schema health ...
psql "%DB_URL%" -v ON_ERROR_STOP=1 -t -A -c "SELECT 'pg_policies: ' || count(*)::text FROM pg_policies;" -c "SELECT 'app_tenant_in_scope(text): ' || COALESCE(to_regprocedure('app_tenant_in_scope(text)')::text, 'MISSING');" -c "SELECT 'foreign keys: ' || count(*)::text FROM pg_constraint WHERE contype = 'f';"

echo.
echo ^>^> Done. If 'pg_policies' is 0 or 'app_tenant_in_scope' is MISSING, the database
echo    is NOT healthy -- do not use it. Re-run on a fresh database.
echo.
echo REPAIR (reload data into a freshly-built database):
echo    1. pg_dump --data-only --no-owner --disable-triggers "<OLD_DB_URL>" ^> data_only.sql
echo    2. createdb lexy_fresh  (then run this script against lexy_fresh)
echo    3. psql "<lexy_fresh_url>" -f data_only.sql   (run as a superuser to bypass RLS during load)
echo    4. Point your app's DATABASE_URL at lexy_fresh and restart.

endlocal
exit /b 0
