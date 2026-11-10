# Lexy documentation and IT acceptance pack

**Latest authentication increment:** read `All-Device-Signout-Verification.md`.
Staff and candidate settings support password-confirmed **Sign out all devices**
with atomic private auditing; ordinary logout remains session-specific.
Deploy migrations **0113 → 0114 → 0115** before coordinated API replacement.
Only development was changed. SSO-only accounts require a future fresh-auth flow;
they do not receive a password-confirmation bypass.

**Earlier authentication increment:** read `Credential-Session-Replica-Verification.md`
first. Password changes now invalidate prior account sessions while logout stays
session-specific. Real cross-process/restart, staff and candidate reset checks
passed. External deployment requires migrations **0113 and 0114** and a coordinated
API cutover; only development was changed here.

Earlier increment: `Session-Handoff-Contention-Closeout.md` in the ZIP.
Session-specific server revocation, human-reported manual offer handoff and
bounded local campaign contention are implemented/tested. Migration **0113** is
required in the identity/control database before external deployment; it was
applied only in development here. This supersedes older cookie-only logout
statements. Live provider/team acceptance remains pending.

Included backend addendum:
[weekly recap recovery](../engineering/weekly-digest-recap-recovery.md).
The refreshed pack includes this recovery change and metadata-only Mail Holds
review. Source-Version.json identifies the exact allowlisted source content.

Automated verification addendum:
[repeatable Mail Holds browser and real-cookie checks](../qa/mail-holds-automated-verification-2026-11-10.md).
The pack includes this report as `Mail-Holds-Automated-Verification.md`.
Five browser scenarios and nine native-session denial scenarios passed. Native
checks are opt-in and development-fingerprint guarded; logout is not claimed as
server-side revocation of copied stateless tokens.

Snapshot: **2026-11-10**. Internal, development-first handoff. This is documentation,
not production approval or a claim that every provider integration has been live-tested.

## Share with the IT team

Start with [the current code handover](code-handover.md): implemented capabilities,
remaining boundaries and one ordered acceptance run. The latest source verification
is [the November 10 closeout](../qa/code-handover-closeout-2026-11-10.md); do not
substitute the historical regression counts below for that final result.

The generated download pack is under
`generated-artifacts/lexy-it-handoff-2026-11-05/`:

- **Lexy-System-Documentation.pdf** — product, architecture, roles, workflows,
  integrations, privacy, configuration, operations, evidence and remaining gaps.
- **Lexy-Code-Handover.pdf** — current scope/boundaries and one ordered team run.
- **Lexy-IT-Test-Plan.pdf** — execution instructions and numbered test cases.
- **Lexy-IT-Test-Cases.xlsx** — editable cases, smoke selection, coverage,
  dependencies, defect log, execution summary and sign-off.
- **Lexy-System-Documentation.html** — self-contained, searchable documentation.
- **Lexy-IT-Handoff.zip** — all outputs, editable Markdown/CSV and technical inventories.
- **Source-Version.json** — base revision plus per-file and combined
  code/config/schema digests, including uncommitted content. No secrets or data.

## Editable sources and regeneration

- `system-documentation.md`: primary handbook.
- `test-cases.py`: curated manual acceptance cases and their requirements.
- `build-pack.py`: produces the workbook and printable documents without touching
  the application, database, secrets, provider accounts or production.
- `render-pack.mjs`: local HTML-to-PDF renderer using the existing Puppeteer package.

Run:

```sh
python docs/team-handoff/build-pack.py
node docs/team-handoff/render-pack.mjs
```

Generated binaries are deliberately excluded from Git/deployments. The Library
cards in the delivery message provide the shareable downloads.

## Start here

1. Read sections 1–5 and the evidence/remaining-gaps sections of the handbook.
2. Assign the sandbox owner, independent job approver, recruiter, meeting host,
   candidate tester, security reviewer and release owner.
3. Fill **Run Setup** in the workbook and keep all execution results **Not Run**
   until the team actually executes them.
4. Run the **Smoke** selection, then the **E2E** cases, then the remaining
   module and negative tests.
5. Never send to real candidates, dispatch a meeting assistant, modify an external
   ATS or run a destructive erasure/load test without the stated approval.
6. Record **Blocked** for missing setup, not **Pass**. A source-review or mocked
   regression is not human acceptance or live provider evidence.

## Important evidence correction

The November 10 combined run completed **58/60 checks**: one missing-subject
regression failed plus its derived API aggregate. The bug was fixed and all
**27 tests in that workflow group passed on rerun**; **43 mail tests** and
**34 runner/planner tests** also passed. The wider run passed **283 frontend
tests, ten browser groups**, schema/type/build/security/lint/format checks.
Its original report is retained, not relabelled 60/60. This is consolidated
development evidence, not a fresh all-green monolithic invocation.
See `docs/qa/code-handover-closeout-2026-11-10.md`.

The refreshed workbook has **252 unique cases across 25 groups**. Every manual
execution result remains **Not Run**. Building this pack does not execute tests,
contact providers or certify production. Its historical output-directory name is
retained for stable download paths; the documents and evidence show the update.
