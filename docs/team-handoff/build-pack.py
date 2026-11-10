"""Build shareable acceptance documents. Reads allowlisted sources only.
Does not access environment configuration, application APIs, databases or providers.
"""
from collections import Counter
import csv
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import xlsxwriter

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / "generated-artifacts/lexy-it-handoff-2026-11-05"
OUT.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location("acceptance_cases", HERE / "test-cases.py")
cases_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cases_module)
cases, groups, languages = cases_module.CASES, cases_module.GROUPS, cases_module.LANGUAGES
index = {c["id"]: i + 2 for i, c in enumerate(cases)}

EVIDENCE = [
    ["E-ALL-DEVICE-SIGNOUT", "2026-11-10", "Password-confirmed all-device sign-out",
     "Ten targeted tests, five API processes/three restarts/86 protected checks, two new browser scenarios and two preserved logout/handoff scenarios passed",
     "Development only. Deploy 0113/0114/0115; SSO-only fresh reauthentication and live team acceptance are not included.",
     "docs/qa/all-device-signout-verification-2026-11-10.md"],
    ["E-CREDENTIAL-REPLICAS", "2026-11-10", "Account credential epochs and real replica/restart revocation",
     "Four OS processes/two restarts; 68 protected cookie/bearer checks; staff and candidate reset endpoints passed with simulated notification transport",
     "Development only. Deploy migrations 0113/0114 before coordinated API cutover; no provider or production capacity claim.",
     "docs/qa/credential-session-replica-verification-2026-11-10.md"],
    ["E-SESSION-HANDOFF-CONTENTION", "2026-11-10", "Session-specific revocation, manual handoff and bounded campaign contention",
     "52 workflow/offer checks; 11 native-cookie denial scenarios/33 rejected requests; two repeatable browser scenarios; 16-recipient/eight-worker isolated campaign contention passed",
     "Development migration 0113 required before external deploy. No production, live ATS receipt, account-wide reset revocation or production capacity claim.",
     "docs/qa/session-handoff-contention-2026-11-10.md"],
    ["E-MAIL-HOLDS-REPEATABLE", "2026-11-10", "Repeatable Mail Holds automated verification",
     "5/5 isolated browser scenarios; nine native-cookie denial scenarios and 27 denied requests with independent authorized control; wrong-target refusal and repeatable cleanup passed",
     "Browser interception is not server authorization. Native cookies prove account/role enforcement, not server-side revocation of copied tokens on logout or production acceptance.",
     "docs/qa/mail-holds-automated-verification-2026-11-10.md"],
    ["E-MAIL-HOLDS", "2026-11-10", "Final independent email handover increment",
     "58 focused email SQL/HTTP tests passed with provider egress blocked; API restart rebuilt types and security guards",
     "Metadata-only review retains send holds; not delivery proof, resend permission, live account acceptance or production certification.",
     "docs/qa/code-handover-closeout-2026-11-10.md"],
    ["E-MAIL-HOLDS-UI", "2026-11-10", "Synthetic intercepted Mail Holds browser pass",
     "Review input/success/conflict, denial cache hiding/recovery and cursor navigation passed; desktop/mobile screenshots",
     "No real account, backend mutation or provider operation. Possible mobile drawer-transition overlap remains a visual acceptance observation.",
     "docs/qa/code-handover-closeout-2026-11-10.md"],
    ["E-HANDOVER", "2026-11-10", "Current code handover",
     "Initial combined run 58/60; one bug fixed and affected 27-test group passed; 43 mail and 34 runner/planner tests passed",
     "Manual rows remain Not Run. No production or live provider certification.",
     "docs/qa/code-handover-closeout-2026-11-10.md"],
    ["E-2026-11-08", "2026-11-08 03:22–03:40 UTC", "Historical combined development regression",
     "60/60 groups; 1,290 API tests in 134 files; 283 frontend logic tests; ten browser groups; lint zero errors and format zero differing files",
     "Includes current attendance and Zoho paths. Synthetic/intercepted fixtures, not manual acceptance, live provider evidence, deployed RLS or production readiness.",
     "docs/qa/independent-development-closeout-2026-11-08.md"],
    ["E-01", "2026-11-05 12:23–12:39 UTC", "Recorded full development regression",
     "56/56 groups; 1,190 API tests in 121 files; 283 frontend logic tests; ten browser groups",
     "Historical recorded result; predates Recall attendance and the later SDK-only follow-up. Not re-executed for this documentation pack.",
     "docs/qa/independent-reliability-and-release-handoff-2026-11-05.md"],
    ["E-02", "2026-11-05", "Recording upload reliability",
     "Private streaming upload; inclusive 100 MiB bound and abort/failure/concurrency fixtures",
     "Synthetic HTTP/SDK/storage evidence, not real cloud permissions or production capacity.",
     "docs/qa/independent-reliability-and-release-handoff-2026-11-05.md"],
    ["E-03", "2026-11-05, after attendance implementation", "Recall focused automated checks",
     "9 tests passed", "Validation/signing/provider/HTTP conditions with mocked provider; not live attendance.",
     "artifacts/api-server/src/lib/meeting-attendance-core.test.ts; artifacts/api-server/src/lib/recall-attendance-provider.test.ts; artifacts/api-server/src/routes/meeting-attendance.test.ts"],
    ["E-04", "2026-11-05, after attendance implementation", "Recall isolated PostgreSQL service checks",
     "8 checks passed; private fixtures rolled back", "Actual service claim/state behavior, simulated provider; no production data or real provider deletion.",
     "artifacts/api-server/src/lib/meeting-attendance.sql-check.ts"],
    ["E-05", "2026-11-05, after attendance implementation", "Recall component browser verification",
     "Desktop and 390px approval/dispatch/unknown/recovery/import/403-cache journey passed",
     "Real component, intercepted auth/API fixtures; no real meeting or candidate communications.",
     "artifacts/lexy/src/components/meeting-attendance-panel.tsx; artifacts/lexy/src/test-fixtures/meeting-attendance-browser.tsx"],
    ["E-06", "2026-11-05, after attendance implementation", "Build and basic runtime",
     "Web/API typechecks and API build/guards passed; health 200; unsigned Recall callback 401",
     "Not a new full combined regression or proof that signed callbacks arrive from Recall.",
     "docs/engineering/recall-live-attendance.md"],
]
DEPENDENCIES = [
    ["D-01", "Exact development acceptance build", "IT / engineering", "Record build/environment and freeze test scope.", "Owner to confirm", "All"],
    ["D-02", "Dummy employer, job and associated application", "Employer admin / recruiter", "Identify actual synthetic records and independent approver; no real-candidate substitution.", "Owner to confirm", "WKO; ZOH; E2E"],
    ["D-03", "Controlled inbox and contact authorization", "Recruiter / candidate tester", "Approve intended recipient and one test send before each live-contact case.", "Owner to confirm", "ENG; INT; ZOH; OFF"],
    ["D-04", "Owned Google/Microsoft/Zoom accounts", "Provider account owners", "Confirm account, permissions, original host, calendar/recording grants and exact callbacks.", "Live acceptance pending", "CAL; GGL; ZOM; MED"],
    ["D-05", "Recall signed lifecycle setup", "Recall workspace owner / IT", "RECALL_WEBHOOK_SECRET was added during handoff preparation. Confirm runtime sees it, dashboard endpoint and signed delivery; do not share the value.", "Secret added; runtime/callback verification pending", "REC; E2E-05"],
    ["D-06", "Recall consented dummy live meeting", "Original Zoom host / consenting participants", "Employer grant plus separate host approval/dispatch; admit bot; verify stop/import/provider cleanup.", "Live acceptance pending", "REC; E2E-05"],
    ["D-07", "Zoho permitted progress/assessment publication", "Employer Zoho admin", "Confirm current application identity, explicit write/disclosure consent and granted scope.", "Owner to confirm", "ZOH-07; ZOH-08"],
    ["D-08", "Zoho remote application advancement", "Product / integration engineering", "Application-specific supported transition contract and controlled writer/read-back/recovery are unfinished.", "Build gap; not a setup-only blocker", "ZOH-09; future remote advancement"],
    ["D-09", "External production, DB and AWS ownership", "External hosting / DB / cloud owners", "Independent target, backup, migrations/security, SES callback receipts and storage/capacity verification.", "Not inspected by this pack", "REL; production launch"],
    ["D-10", "Greenhouse optional live account", "Employer ATS owner", "Explicit platform allocation plus independent exact-employer confirmation before read-only acceptance.", "Owner to confirm / may be out of launch scope", "ATS"],
    ["D-11", "Fluent language reviewers", "QA lead / language reviewers", "Assign a fluent reviewer for every offered locale and retain private source comparison.", "Owner to assign", "LNG"],
    ["D-12", "Post-attendance full combined regression", "Engineering", "Run once on final acceptance build and retain final report; do not substitute pre-attendance evidence.", "Verification pending", "REL-03"],
    ["D-13", "Destructive/load test approval", "Security / release / data owner", "Disposable targets, bounded agreed load, cleanup/rollback owner and no production mutation.", "Explicit approval required", "SEC; REL-04; REC-11"],
]


def csv_file(name, headers, rows):
    with (OUT / name).open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(rows)


case_headers = [
    "Case ID", "Module", "Title", "Priority", "Execution mode", "Persona", "Navigation",
    "Preconditions", "Steps", "Expected result", "Dependency", "Cleanup / risk controls",
    "Status", "Tester", "Executed at / timezone", "Actual result", "Evidence (safe reference)",
    "Defect ID", "Retest result", "Build / environment", "Comments",
]
case_rows = []
for c in cases:
    case_rows.append([
        c["id"], c["module"], c["title"], c["priority"], c["mode"], c["role"], c["path"],
        c["preconditions"], "\n".join(f"{i}. {step}" for i, step in enumerate(c["steps"], 1)),
        c["expected"], c["dependency"], c["cleanup"], "Not Run", "", "", "", "", "", "", "", "",
    ])
csv_file("Lexy-IT-Test-Cases.csv", case_headers, case_rows)
(OUT / "Lexy-IT-Test-Cases.json").write_text(json.dumps(cases, indent=2, ensure_ascii=False), encoding="utf-8")

# Allowlisted static inventories. No app API, database rows or secret files.
app = ROOT / "artifacts/lexy/src/App.tsx"
routes = []
for n, line in enumerate(app.read_text().splitlines(), 1):
    found = re.search(r'<Route path="([^"]+)"', line)
    if found:
        roles = re.search(r'roles=\{(.*?)\}', line)
        component = re.search(r'component=\{(\w+)\}', line)
        routes.append([found[1], component.group(1) if component else "See source",
                       roles.group(1) if roles else "See route/component authorization",
                       str(app.relative_to(ROOT)), n])
csv_file("Lexy-UI-Route-Inventory.csv", ["Path", "Component", "Route role expression", "Source", "Line"], routes)

api = ROOT / "lib/api-spec/openapi.yaml"
operations = []
path, method, op_line = "", "", 0
for n, line in enumerate(api.read_text().splitlines(), 1):
    m = re.match(r'^  (/[^:]+):\s*$', line)
    if m:
        path = m.group(1)
    m = re.match(r'^    (get|post|put|patch|delete|head|options):\s*$', line)
    if path and m:
        method, op_line = m.group(1).upper(), n
    m = re.match(r'^      operationId:\s*(.+?)\s*$', line)
    if m and path and method:
        operations.append([method, path, m.group(1), "OpenAPI contract; inspect runtime authorization",
                           "lib/api-spec/openapi.yaml", op_line])
csv_file("Lexy-OpenAPI-Operation-Inventory.csv",
         ["Method", "Contract path", "Operation ID", "Boundary", "Source", "Line"], operations)
tables = []
for p in sorted((ROOT / "lib/db/src/schema").glob("*.ts")):
    text = p.read_text()
    for m in re.finditer(r'\bpgTable\(\s*["\']([^"\']+)["\']', text):
        tables.append([m.group(1), str(p.relative_to(ROOT)), text[:m.start()].count("\n") + 1,
                       "Source definition only; installed schema and RLS require operator verification"])
csv_file("Lexy-Database-Table-Inventory.csv", ["Table", "Schema source", "Line", "Boundary"], tables)
assert routes and operations and tables

wb = xlsxwriter.Workbook(OUT / "Lexy-IT-Test-Cases.xlsx")
wb.set_properties({"title": "Lexy IT Acceptance Test Pack", "subject": "Development-first manual acceptance",
                   "author": "Lexy", "comments": "All manual results start Not Run; historical evidence is separate."})
navy, teal = "#102338", "#087F8C"
head = wb.add_format({"bold": True, "bg_color": navy, "font_color": "white", "text_wrap": True, "valign": "top"})
text = wb.add_format({"text_wrap": True, "valign": "top", "font_size": 10})
user_input = wb.add_format({"text_wrap": True, "valign": "top", "bg_color": "#FFF3CC", "font_color": "#174A7E", "font_size": 10})
title = wb.add_format({"bold": True, "font_size": 19, "font_color": navy})
note = wb.add_format({"text_wrap": True, "valign": "top", "bg_color": "#EAF5F7"})
formula = wb.add_format({"bold": True, "num_format": "0", "font_color": navy})
percent = wb.add_format({"num_format": "0.0%", "bold": True})
link = wb.add_format({"font_color": "#075D98", "underline": True, "text_wrap": True, "valign": "top"})


def table_sheet(name, headers, rows, widths=None):
    ws = wb.add_worksheet(name)
    ws.hide_gridlines(2)
    ws.freeze_panes(1, 1)
    ws.set_default_row(65)
    ws.set_row(0, 34, head)
    for i, width in enumerate(widths or [28] * len(headers)):
        ws.set_column(i, i, width, text)
    ws.write_row(0, 0, headers, head)
    for row_n, row in enumerate(rows, 1):
        ws.write_row(row_n, 0, row, text)
    if rows:
        ws.add_table(0, 0, len(rows), len(headers) - 1, {
            "name": re.sub("[^A-Za-z0-9]", "", name) + "Table",
            "columns": [{"header": h} for h in headers], "style": "Table Style Medium 2",
        })
    return ws


readme = wb.add_worksheet("Read Me")
readme.hide_gridlines(2)
readme.set_column("A:A", 28)
readme.set_column("B:B", 108)
readme.merge_range("A1:B1", "Lexy • IT acceptance pack", title)
instructions = [
    ("Snapshot", "2026-11-10. Development first. This workbook is an unexecuted manual acceptance plan, not release approval."),
    ("Canonical results", "Edit result cells only in Cases. Smoke and E2E tabs link to the canonical rows and mirror their statuses."),
    ("Execution order", "Run Setup → Smoke → E2E journeys → module/negative cases → approved live providers → exact-build regression → Sign-off."),
    ("Initial status", f"All {len(cases)} cases start Not Run. Missing permission/setup is Blocked, never Pass."),
    ("Language coverage", f"{len(languages)} locale rows were extracted from the current server catalog. Offered-to-tenant/runtime capability still needs confirmation and fluent review."),
    ("Yellow cells", "User execution inputs. Preserve expected results; put what actually happened in Actual result and link sanitized evidence/defects."),
    ("Safety", "No real candidate contact, offer, meeting dispatch, destructive erasure or load testing without the case's explicit prerequisites/owner approval."),
    ("Evidence", "Recorded pre-attendance full regression passed 56/56 groups. Later Recall focused checks are separate. This workbook does not claim a new full combined run."),
    ("Secret update", "RECALL_WEBHOOK_SECRET was added during documentation preparation. No secret value was read, no runtime restart performed and no signed/live callback was verified by this pack."),
    ("Privacy", "Never paste keys, passwords, cookies, signed media URLs, verification codes or real candidate private content into this workbook."),
    ("Results", "Not Run; Pass; Fail; Blocked; Not Applicable. N/A requires owner-approved scope reason. Retest does not silently overwrite the original defect."),
    ("Go/no-go", "Zero P0 failures is necessary but not sufficient. Blocked required cases, live acceptance, production readiness and actual release sign-off remain separate."),
]
for row, (label, value) in enumerate(instructions, 3):
    readme.write(row, 0, label, head)
    readme.write(row, 1, value, note)
    readme.set_row(row, 48)

setup_rows = [[v, "", h] for v, h in [
    ("Test run name", "Use a unique internal label; no secret-bearing URL."),
    ("Build / source reference", "Record exact build before running; frozen scope."),
    ("Application origin", "Development URL, not inferred production."),
    ("API origin / environment", "Operator confirmed; no production mutations."),
    ("Database identity verified by", "Authorized owner reference only, no connection string."),
    ("Start date / timezone", "Required to reconcile provider receipts."),
    ("QA lead", "Owns assignment and completeness."),
    ("Work-order author", "Different from independent approver."),
    ("Independent job approver", "Eligible current employer scope."),
    ("Recruiter / hiring manager", "Record named responsibilities separately."),
    ("Controlled candidate inbox / tester", "Internal safe alias/reference; consent before contact."),
    ("Original meeting host", "Owner of provider account and managed appointment."),
    ("Dummy employer / job / application labels", "Actual linked fixtures; no real candidates."),
    ("Provider permissions verified by", "Google/Microsoft/Zoom/Zoho/Recall as applicable."),
    ("Recording / contact consent reference", "Safe consent record reference, not private payload."),
    ("Recall runtime / signed callback verified by", "Secret added does not prove delivery."),
    ("Destructive/load test approval", "Disposable target, bounded load, cleanup owner."),
    ("Launch scope exclusions", "Explicit owner approval required."),
    ("Rollback / incident owner", "Before any rollout."),
]]
setup = table_sheet("Run Setup", ["Field", "Team entry", "Instruction"], setup_rows, [34, 44, 85])
setup.set_column("B:B", 44, user_input)

ws = table_sheet("Cases", case_headers, case_rows,
                 [13, 28, 47, 10, 26, 38, 37, 70, 85, 85, 48, 64, 18, 23, 26, 70, 50, 20, 21, 32, 48])
ws.freeze_panes(1, 3)
ws.set_default_row(145)
for col in range(12, 21):
    ws.set_column(col, col, [18, 23, 26, 70, 50, 20, 21, 32, 48][col - 12], user_input)
ws.data_validation(1, 12, len(cases), 12, {"validate": "list", "source": ["Not Run", "Pass", "Fail", "Blocked", "Not Applicable"],
                   "error_type": "stop", "error_title": "Use an execution result", "error_message": "Select a supported status."})
ws.data_validation(1, 18, len(cases), 18, {"validate": "list", "source": ["", "Pass", "Fail", "Blocked", "Not Applicable"]})
for status, bg, fg in [("Pass", "#E5F2E8", "#23603B"), ("Fail", "#FBE5E5", "#A32121"),
                       ("Blocked", "#FFF0CE", "#8F5700"), ("Not Run", "#EDEFF3", "#485268")]:
    fmt = wb.add_format({"bg_color": bg, "font_color": fg})
    ws.conditional_format(1, 12, len(cases), 12, {"type": "cell", "criteria": "equal to", "value": f'"{status}"', "format": fmt})


def subset_sheet(name, ids):
    rows = [[cid, cases[index[cid] - 2]["module"], cases[index[cid] - 2]["title"],
             cases[index[cid] - 2]["priority"], "", ""] for cid in ids]
    sub = table_sheet(name, ["Case ID", "Module", "Title", "Priority", "Current Cases status", "Open canonical row"], rows,
                      [14, 32, 65, 12, 24, 25])
    for n, cid in enumerate(ids, 1):
        sub.write_formula(n, 4, f"=Cases!M{index[cid]}", text, "Not Run")
        sub.write_url(n, 5, f"internal:'Cases'!A{index[cid]}", link, "Open case / record result")


subset_sheet("Smoke", cases_module.SMOKE_IDS)
subset_sheet("E2E Journeys", [c["id"] for c in cases if c["group"] == "E2E"])
coverage = []
for g in groups:
    own = [c for c in cases if c["group"] == g["code"]]
    coverage.append([g["code"], g["module"], len(own), sum(c["priority"] == "P0" for c in own),
                     f"{own[0]['id']} … {own[-1]['id']}", g["path"], g["dependency"], "Owner to assign"])
table_sheet("Coverage", ["Group", "Module", "Cases", "P0", "Case range", "Navigation", "Dependency / scope", "Owner"], coverage,
            [12, 43, 12, 10, 24, 52, 70, 28])
summary = wb.add_worksheet("Execution Summary")
summary.hide_gridlines(2)
summary.set_column("A:A", 40)
summary.set_column("B:B", 20)
summary.set_column("D:D", 100)
summary.write("A1", "Current manual execution", title)
summary.write("D3", "Formulas recalculate in Excel. Initial cached values reflect every case Not Run.", note)
summary.write("D5", "Cases is the sole result source; historical evidence and Smoke/E2E mirrors are not counted twice.", note)
last = len(cases) + 1
stats = [("Total planned", f"=COUNTA(Cases!A2:A{last})", len(cases))]
stats += [(s, f'=COUNTIF(Cases!M2:M{last},"{s}")', len(cases) if s == "Not Run" else 0)
          for s in ["Pass", "Fail", "Blocked", "Not Run", "Not Applicable"]]
stats += [("P0 not passed", f'=COUNTIFS(Cases!D2:D{last},"P0",Cases!M2:M{last},"<>Pass")',
           sum(c["priority"] == "P0" for c in cases))]
for row, (label, f, cache) in enumerate(stats, 3):
    summary.write(row, 0, label, text)
    summary.write_formula(row, 1, f, formula, cache)
summary.write("A13", "Pass rate of applicable planned cases", text)
summary.write_formula("B13", '=IFERROR(B5/(B4-B9),0)', percent, 0)
summary.write("A15", "Release decision", head)
summary.write("B15", "NOT APPROVED", user_input)
summary.write("D15", "Manual owner sign-off required; this cell is not computed from counts.", note)
summary.write("A18", "Module", head)
summary.write("B18", "Passed / planned", head)
for row, g in enumerate(groups, 18):
    summary.write(row, 0, g["module"], text)
    summary.write_formula(row, 1, f'=COUNTIFS(Cases!B2:B{last},A{row+1},Cases!M2:M{last},"Pass")&" / "&COUNTIF(Cases!B2:B{last},A{row+1})',
                          text, f"0 / {sum(c['group'] == g['code'] for c in cases)}")

lang_cases = [c for c in cases if c["group"] == "LNG"]
lang_rows = [[c["id"], l["code"], l["label"], "", "", "", "", "", "", "", ""]
             for c, l in zip(lang_cases, languages)]
lang = table_sheet("Language Matrix",
    ["Case ID", "Locale", "Catalog label", "Offered to tenant?", "Fluent reviewer", "Observed STT", "Observed TTS",
     "Observed LLM route", "Evidence safe ref", "Current Cases status", "Comments"],
    lang_rows, [14, 15, 40, 21, 25, 25, 25, 30, 45, 24, 48])
for row, c in enumerate(lang_cases, 1):
    lang.write_formula(row, 9, f"=Cases!M{index[c['id']]}", text, "Not Run")
lang.data_validation(1, 3, len(lang_rows), 3, {"validate": "list", "source": ["Yes", "No", "Not checked"]})
table_sheet("Dependencies", ["ID", "Dependency / gap", "Owner", "Required action", "Current boundary", "Cases"], DEPENDENCIES,
            [12, 43, 33, 100, 57, 35])
table_sheet("Evidence", ["Ref", "Recorded time", "Evidence", "Recorded outcome", "Limits", "Source"], EVIDENCE,
            [12, 38, 43, 100, 100, 100])
defects = table_sheet("Defect Log",
    ["Defect ID", "Case IDs", "Severity", "Title", "Environment / build", "Steps / actual result", "Expected",
     "Safe evidence ref", "Owner", "State", "Fix / retest reference"], [[""] * 11 for _ in range(100)],
    [18, 25, 18, 50, 38, 85, 70, 48, 25, 22, 65])
for col, width in enumerate([18, 25, 18, 50, 38, 85, 70, 48, 25, 22, 65]):
    defects.set_column(col, col, width, user_input)
defects.data_validation(1, 2, 100, 2, {"validate": "list", "source": ["Critical", "High", "Medium", "Low"]})
defects.data_validation(1, 9, 100, 9, {"validate": "list", "source": ["New", "Triaged", "In progress", "Ready for retest", "Closed", "Deferred"]})
signoff_rows = [[area, owner, "", "", "", ""] for area, owner in [
    ("Native hiring journey", "Recruiting lead + independent approver"), ("Interview/capture/languages", "QA + fluent reviewers"),
    ("Calendar privacy and provider lifecycle", "Meeting hosts + security"), ("Zoho import/campaign/publication", "Employer ATS owner"),
    ("Recall attendance and remote cleanup", "Recall workspace owner + original host"), ("Human-controlled offers", "Employer offer owner"),
    ("Candidate learning/privacy/erasure", "Privacy/security + candidate QA"), ("Full exact-build regression", "Engineering"),
    ("External production/schema/storage/SES", "IT/cloud/database owners"), ("Release and rollback decision", "Release owner"),
]]
signoff = table_sheet("Sign-off", ["Area", "Responsible role", "Named owner", "Decision", "Date / timezone", "Evidence / exclusions"], signoff_rows,
                      [48, 49, 28, 24, 28, 90])
signoff.data_validation(1, 3, len(signoff_rows), 3, {"validate": "list", "source": ["Not reviewed", "Accepted", "Rejected", "Blocked", "Out of scope"]})
wb.close()

test_md = [
    "# Lexy — IT Acceptance Test Plan",
    "**Snapshot: November 5, 2026 · Development-first · Internal**",
    f"This plan contains **{len(cases)} unexecuted manual cases**, including **{len(cases_module.SMOKE_IDS)} smoke selections**, "
    f"**8 cross-functional end-to-end journeys** and **{len(languages)} configured-language cases**.",
    "## 1. Execution and safety",
    "Use the Excel workbook as the editable execution record. All results start Not Run. "
    "Smoke/E2E sheets mirror Cases rather than creating duplicate result records. Missing setup is Blocked, not Pass. "
    "Run Setup records build/environment, named testers, independent approver, controlled inbox, consent and rollback owner.",
    "Test development and dummy identities first. No case grants permission to contact a real candidate, send an offer, "
    "join a meeting, change an external ATS, run destructive erasure or load production. Obtain the case-specific approval first.",
    "Order: Smoke → same-identity E2E journeys → module and negative cases → approved live providers → "
    "one exact-build developer regression → defect retest and real release sign-off.",
    "Priority: P0 = privacy/data loss/unauthorized external action/core blocker; P1 = material functionality/recovery; "
    "P2 = secondary issue. Defect severity is assessed separately. Release acceptance is never just a formula.",
    "Record tester, build/environment, timestamp/timezone, actual result, sanitized evidence, defect ID and retest. "
    "Never include keys, cookies, verification codes, signed media URLs or real candidate private content.",
    "## 2. Evidence boundary",
    "The historical November 8 combined development regression passed 60/60 groups: 1,290 API tests in 134 files, "
    "283 frontend logic tests, ten browser groups and schema/type/build/security/lint/format checks. "
    "It includes current attendance and Zoho paths but is not live provider or manual acceptance. "
    "None of those results pre-fills a manual acceptance row. "
    "Use Current-Development-Closeout.md for final November 10 source verification and Lexy-Code-Handover.pdf for the ordered run.",
    "Recall secret and callback setup were reported complete by the owner; actual signed callback delivery "
    "and a consented live meeting still require acceptance. No secret value is included in this pack.",
    "## 3. Prerequisites and known build gaps",
]
for row in DEPENDENCIES:
    test_md.append(f"### {row[0]} — {row[1]}\n\n**Owner:** {row[2]}. **Boundary:** {row[4]}.\n\n{row[3]}\n\n**Cases:** {row[5]}.")
test_md += ["## 4. Smoke selection", ", ".join(cases_module.SMOKE_IDS),
            "## 5. Detailed cases", "Expected outcomes below are requirements to verify, not completed observations."]
for g in groups:
    own = [c for c in cases if c["group"] == g["code"]]
    test_md.append(f"### {g['code']} — {g['module']} ({len(own)} cases)")
    for c in own:
        test_md.append(
            f"#### {c['id']} · {c['priority']} · {c['title']}\n\n"
            f"**Persona:** {c['role']}. **Navigation:** {c['path']}.\n\n"
            f"**Preconditions:** {c['preconditions']}\n\n"
            + "\n".join(f"{i}. {step}" for i, step in enumerate(c["steps"], 1))
            + f"\n\n**Expected:** {c['expected']}\n\n"
            f"**Dependency:** {c['dependency']}\n\n**Cleanup/risk:** {c['cleanup']}\n\n"
            "**Execution record:** Not Run · Tester: ______ · Build/environment: ______ · "
            "Actual/evidence/defect/retest: record in workbook.\n")
(OUT / "Lexy-IT-Test-Plan.md").write_text("\n\n".join(test_md), encoding="utf-8")
shutil.copy2(HERE / "system-documentation.md", OUT / "Lexy-System-Documentation.md")
shutil.copy2(HERE / "README.md", OUT / "START-HERE.md")
shutil.copy2(HERE / "code-handover.md", OUT / "Lexy-Code-Handover.md")
shutil.copy2(ROOT / "docs/qa/code-handover-closeout-2026-11-10.md", OUT / "Current-Development-Closeout.md")
shutil.copy2(ROOT / "docs/engineering/weekly-digest-recap-recovery.md", OUT / "Weekly-Recap-Recovery.md")
shutil.copy2(ROOT / "docs/qa/mail-holds-automated-verification-2026-11-10.md", OUT / "Mail-Holds-Automated-Verification.md")
shutil.copy2(ROOT / "docs/qa/session-handoff-contention-2026-11-10.md", OUT / "Session-Handoff-Contention-Closeout.md")
shutil.copy2(ROOT / "lib/db/drizzle/0113_session_revocations.sql", OUT / "Session-Revocation-Migration.sql")
shutil.copy2(ROOT / "lib/db/drizzle/0114_credential_session_versions.sql", OUT / "Credential-Session-Version-Migration.sql")
shutil.copy2(ROOT / "lib/db/drizzle/0115_explicit_all_session_revocation.sql", OUT / "All-Device-Signout-Migration.sql")
shutil.copy2(ROOT / "docs/qa/all-device-signout-verification-2026-11-10.md", OUT / "All-Device-Signout-Verification.md")
shutil.copy2(ROOT / "docs/qa/credential-session-replica-verification-2026-11-10.md", OUT / "Credential-Session-Replica-Verification.md")

# Content hashes only: never export source file contents, secrets or a DB dump.
# Include uncommitted source so a base commit cannot misidentify the tested tree.
source_paths = subprocess.check_output(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT
).decode().split("\0")
source_entries = []
extensions = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".sql", ".css", ".html", ".py", ".toml"}
root_configs = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json", ".replit"}
for name in sorted(set(source_paths)):
    p = ROOT / name
    if not name or not p.is_file() or p.is_symlink():
        continue
    parts = Path(name).parts
    if any(part in {"node_modules", "dist", "build", "generated-artifacts", "attached_assets"} for part in parts):
        continue
    if name not in root_configs and not (
        parts[0] in {"artifacts", "lib", "scripts"} and p.suffix in extensions
    ):
        continue
    if any(part.startswith(".env") for part in parts):
        continue
    source_entries.append({"path": name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
source_version = {
    "base_git_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    "source_digest_sha256": hashlib.sha256(json.dumps(source_entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
    "scope": "Allowlisted code/config/schema files, including uncommitted files. Excludes media, ignored files, secrets, database data and generated binaries.",
    "files": source_entries,
}
(OUT / "Source-Version.json").write_text(json.dumps(source_version, indent=2), encoding="utf-8")
csv_file("Lexy-Recorded-Evidence.csv", ["Ref", "Time", "Evidence", "Outcome", "Limit", "Source"], EVIDENCE)
csv_file("Lexy-Dependencies-and-Gaps.csv", ["ID", "Dependency", "Owner", "Action", "Boundary", "Cases"], DEPENDENCIES)
manifest = {
    "snapshot": "2026-11-10", "case_count": len(cases), "module_groups": len(groups),
    "p0_cases": sum(c["priority"] == "P0" for c in cases), "smoke_count": len(cases_module.SMOKE_IDS),
    "language_count": len(languages), "ui_routes": len(routes), "openapi_operations": len(operations),
    "schema_table_definitions": len(tables), "manual_execution": "Not Run",
    "production_access": False, "provider_operations": False,
    "verification_mode": "historical combined execution plus scoped email, browser, native-cookie, credential-epoch and cross-process/restart checks; not a fresh all-green monolithic invocation",
    "source_digest_sha256": source_version["source_digest_sha256"],
    "source_version_file": "Source-Version.json",
    "sender_source_hashes": {
        str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (ROOT / "artifacts/api-server/src/lib" / name for name in [
            "cadenced-communication.ts", "recorded-communication.ts",
            "mail-hold-review.ts", "weekly-digest-recap.ts",
            "linkedin-profile-monitor.ts", "weekly-digest-scheduler.ts",
            "post-hire-pulse-scheduler.ts", "outreach-engine.ts", "outreach-mail-attempt.ts"])
    },
    "source_hashes": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in [HERE / "system-documentation.md", HERE / "test-cases.py",
                                HERE / "build-pack.py", HERE / "render-pack.mjs", HERE / "README.md", app, api,
                                ROOT / "docs/qa/independent-reliability-and-release-handoff-2026-11-05.md",
                                ROOT / "docs/qa/independent-development-closeout-2026-11-08.md",
                                ROOT / "docs/qa/code-handover-closeout-2026-11-10.md",
                                ROOT / "docs/qa/mail-holds-automated-verification-2026-11-10.md",
                                ROOT / "docs/qa/session-handoff-contention-2026-11-10.md",
                                ROOT / "docs/qa/credential-session-replica-verification-2026-11-10.md",
                                ROOT / "docs/qa/all-device-signout-verification-2026-11-10.md",
                                HERE / "code-handover.md"]},
}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(json.dumps(manifest, indent=2))
