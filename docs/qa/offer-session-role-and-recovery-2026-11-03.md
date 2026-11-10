# Active-role access and interrupted-fixture recovery — 2026-11-03

## Verified results

**PASS in independently verified development.** No production access, external
integration calls, real staff changes, candidate emails or offer deliveries.
No authorization, offer-routing, LLM, pricing or application UI runtime logic
was relaxed or changed to make these checks pass.

### Real active-account role changes

The existing real-session browser runner now covers two separate scenarios,
each with its own isolated employer, two real password/cookie sessions and 26
synthetic candidate/application/workflow records:

- Suspension continues to deny list, cursor and selected-detail access and
  hide already-rendered cached data.
- The second scenario uses the retained admin's native user-management endpoint
  to change the other admin's role to **interviewer**, without suspending it.
  The original session still receives 200 from `auth/me`, with the new role,
  both before and after the UI privacy check. Its inbox list, cursor page and
  selected detail must each return 403 without private offer/candidate data.
  Ordinary UI polling hides the previously loaded rows and selected detail,
  without a reload or direct query-cache manipulation.
- The other assigned admin keeps real list/cursor/detail access and can refresh,
  load the second page and retain its selection.

Both scenarios passed against native endpoints with separate browser contexts,
not substituted auth or inbox responses. Controlled offer terms, outcomes and
fees remained absent. All accounts and business fixtures were removed afterward.

### Controlled process interruption and recovery

The recovery test starts two **directly owned child fixture processes**, without
launching Chromium. It verified:

1. Cleanup refuses a fixture whose recorded process is still running.
2. Altering its process start identity does not bypass protection: immutable
   journal identity is bound to the fixture's database ownership marker.
3. Killing child A with `SIGKILL` bypasses `finally` and really leaves its
   committed fixture behind.
4. Wrong database proof and a journal edited to reference the live peer's
   employer are refused without deleting either fixture.
5. Explicit recovery deletes only A's recorded fixture. Repeating recovery is
   safe. B's live process and its exact business-record counts remain intact.
6. Sending B `SIGTERM` lets its ordinary cleanup complete before exit. Its
   cleaned journal remains valid for repeat recovery.

This does not pretend that `finally` executes on `SIGKILL`, or that a lost
journal can safely be reconstructed from a broad database prefix scan.

### Pure guard checks and final cleanup evidence

**12 unit tests passed** covering valid/invalid command modes, duplicate/empty
flags, private file/directory permissions, strict identity fields, process
identity, ownership binding, symlinks, path traversal, oversized files and
repeat completion. The pure test file is registered in the combined assisted
baseline; the database-mutating integration commands remain explicit opt-ins.

The actual public cleanup command was also exercised against a completed
journal. Empty cleanup input was refused rather than starting a fresh fixture.
Missing development proof was refused even when a valid journal was supplied.

An independent query through the explicit development database handle found
zero remaining test-namespace employers, staff, jobs, candidates, applications,
workflows, journeys, outcomes or fees after these runs. Security/access-log
retention was not changed.

## Running the checks

First obtain the fingerprint through the **explicit development SQL handle**,
not from the application pool or a saved journal:

```sql
SELECT md5(current_database() || ':' || system_identifier::text)
  AS development_fingerprint
FROM pg_control_system();
```

With development services already running:

```sh
# No database writes: pure command/journal guards.
pnpm run test:offer-session-journal

# Both native browser scenarios; optional --scenario=role-change selects only that case.
pnpm run test:offer-session-access --development-fingerprint=<verified-development-fingerprint>

# Creates and interrupts only its own disposable fixture child processes.
pnpm run test:offer-session-recovery --development-fingerprint=<verified-development-fingerprint>
```

The browser runner prints a non-secret `RECOVERY_JOURNAL` basename **before**
fixture preparation. For an interrupted run, copy that exact basename:

```sh
pnpm run test:offer-session-access --cleanup=offer_session_<uuid>.json --development-fingerprint=<verified-development-fingerprint>
```

Use a basename, not a path or wildcard. `--cleanup` cannot be combined with a
new scenario or preparation mode. A private, bounded write-ahead journal under
`generated-artifacts/offer-session-journals/` records canonical IDs and
non-secret ownership metadata only—never passwords, tokens or connection strings.
It is synced before the fixture transaction begins. Its completed state is
retained for safe repeated cleanup. Files and directories are private and ignored
by Git/deployment.

Recovery checks both configured database handles against freshly supplied proof,
refuses live owners using PID/start identity/boot identity, validates the
database-bound immutable journal marker, and validates exact record ownership.
Deletion is scoped to the recorded tenant **and** canonical record IDs and is
serialized per fixture. Unexpected records, real offer activity, moved records,
ownership changes or a recreated completed fixture cause refusal, not broader
deletion. No prefix-wide sweep occurs. Missing, lost or damaged journals require
manual review; do not hand-edit metadata to bypass a refusal.

`--prepare-only` exists for the controlled interruption check. It creates a
disposable fixture, reports readiness and waits for termination; it is not the
normal browser-test mode.

## Source and limits

The runners, fixture, command guards, journal store and recovery helper live in
`artifacts/api-server/scripts/offer-session-*` and
`artifacts/api-server/scripts/check-offer-session-*`. The real browser driver is
`artifacts/lexy/scripts/check-offer-session-access.mjs`.

Formatting, changed-source ESLint, syntax and whitespace checks passed. No
unrelated full combined-baseline run or service restart was needed.

This adds an active-admin-to-interviewer role transition, not every possible
role or requisition reassignment. It is not proof of cross-customer isolation,
production cookies/proxy configuration, live Zoho/calendar/meeting providers,
real offer delivery, or crash recovery when the ownership journal is lost.
